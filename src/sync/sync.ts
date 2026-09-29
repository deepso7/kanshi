// `kanshi sync`: load the current resources over the API, diff them with
// the config and apply the plan, one request at a time.
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { MonitorListItem, MonitorResponse } from "../api/spec.ts";
import type { KanshiConfig } from "../config.ts";
import { ChannelView } from "../domain/channel.ts";
import { resolveDesired } from "./desired.ts";
import type {
  ChannelPatch,
  ChannelRefs,
  Current,
  CurrentMonitor,
  Desired,
  DesiredChannel,
  DesiredMonitor,
  MonitorPatch,
  Plan,
} from "./plan.ts";
import { Step, describeStep, diff, formatPlan } from "./plan.ts";

export class SyncError extends Schema.TaggedError<SyncError>()("SyncError", {
  message: Schema.String,
  /** The request never got an answer (worth retrying while starting). */
  transport: Schema.optionalKey(Schema.Boolean),
}) {}

export interface SyncOptions {
  readonly adopt?: boolean;
  /** Base URL of the Worker, e.g. `https://kanshi.example.workers.dev`. */
  readonly baseUrl: string;
  readonly config: KanshiConfig;
  /** Print the plan, change nothing. */
  readonly dryRun?: boolean;
  /** The API token (KANSHI_API_TOKEN). */
  readonly token: Redacted.Redacted<string> | string;
  /** Retry the first request for this long (the dev stack may be starting). */
  readonly waitSeconds?: number;
}

export interface SyncResult {
  /** Steps applied (0 on a dry run). */
  readonly applied: number;
  readonly plan: Plan;
}

const ErrorBody = Schema.Struct({ message: Schema.String });
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(ErrorBody)
);

const failure = (
  label: string,
  response: HttpClientResponse.HttpClientResponse
) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) => {
      // A JSON error body gives its message; anything else is shown as is.
      const detail = decodeErrorBody(text).pipe(
        Option.match({ onNone: () => text, onSome: ({ message }) => message })
      );
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      return Effect.fail(
        new SyncError({
          message: `${label} failed with HTTP ${response.status}${suffix}`,
        })
      );
    })
  );

/** A channel as `POST /api/channels` takes it. */
interface ChannelCreateBody extends Omit<DesiredChannel, "urlHash"> {
  readonly managed: true;
}

/** A monitor as `POST /api/monitors` takes it (channels by id). */
interface MonitorCreateBody extends DesiredMonitor {
  readonly managed: true;
}

/** Every JSON body sync sends. */
type RequestBody =
  | ChannelCreateBody
  | ChannelPatch
  | MonitorCreateBody
  | MonitorPatch;

const withBody = (
  request: HttpClientRequest.HttpClientRequest,
  body: RequestBody
) => HttpClientRequest.bodyJsonUnsafe(request, body);

const makeApi = (options: SyncOptions) =>
  Effect.gen(function* makeApiEffect() {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.prependUrl(options.baseUrl.replace(/\/+$/u, "")),
          HttpClientRequest.bearerToken(options.token),
          HttpClientRequest.acceptJson
        )
      )
    );

    /** Run the request; any status of 300 or more is a `SyncError`. */
    const execute = (
      label: string,
      request: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, SyncError> =>
      client.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new SyncError({
              message: `${label} failed: ${cause.message}`,
              transport: true,
            })
        ),
        Effect.flatMap((response) => {
          if (response.status === 401) {
            return Effect.fail(
              new SyncError({
                message: `${label} failed: 401 Unauthorized (check KANSHI_API_TOKEN)`,
              })
            );
          }
          if (response.status >= 300) {
            return failure(label, response);
          }
          return Effect.succeed(response);
        })
      );

    /** A request whose response body is ignored. */
    const call = (
      label: string,
      request: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<void, SyncError> =>
      execute(label, request).pipe(Effect.asVoid);

    /** A request whose response body is decoded with `schema`. */
    const read = <A>(
      label: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, unknown>
    ): Effect.Effect<A, SyncError> =>
      execute(label, request).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
            Effect.mapError(
              (cause) =>
                new SyncError({
                  message: `${label}: unexpected response: ${cause.message}`,
                })
            )
          )
        )
      );

    return { call, read };
  });

type Api = Effect.Success<ReturnType<typeof makeApi>>;

const toCurrentMonitor = (monitor: MonitorResponse): CurrentMonitor => ({
  channels: monitor.channels,
  id: monitor.id,
  key: monitor.key,
  managed: monitor.managed,
  name: monitor.name,
  settings: {
    bodyContains: monitor.bodyContains,
    enabled: monitor.enabled,
    expectedStatus: monitor.expectedStatus,
    failureThreshold: monitor.failureThreshold,
    intervalSeconds: monitor.intervalSeconds,
    method: monitor.method,
    name: monitor.name,
    public: monitor.public,
    successThreshold: monitor.successThreshold,
    timeoutMs: monitor.timeoutMs,
    url: monitor.url,
  },
});

/**
 * Channels and monitors as the API reports them. The full configuration
 * is only read for managed monitors and for monitors whose key is in the
 * config (the rest are only checked for key collisions), and for every
 * monitor when a managed channel is about to be deleted (its users must
 * be known).
 */
const loadCurrent = (api: Api, desired: Desired, waitSeconds: number) =>
  Effect.gen(function* loadCurrentEffect() {
    const listed = yield* api
      .read(
        "GET /api/monitors",
        HttpClientRequest.get("/api/monitors"),
        Schema.Array(MonitorListItem)
      )
      .pipe(
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          times: waitSeconds,
          while: (error) => error.transport === true,
        })
      );
    const channels = yield* api.read(
      "GET /api/channels",
      HttpClientRequest.get("/api/channels"),
      Schema.Array(ChannelView)
    );
    const wantedKeys = new Set(desired.monitors.map((monitor) => monitor.key));
    const wantedChannels = new Set(
      desired.channels.map((channel) => channel.key)
    );
    const deletesChannels = channels.some(
      (channel) => channel.managed && !wantedChannels.has(channel.key)
    );
    const monitors = yield* Effect.forEach(
      listed,
      (item) =>
        deletesChannels || item.managed || wantedKeys.has(item.key)
          ? api
              .read(
                `GET /api/monitors/${item.id}`,
                HttpClientRequest.get(
                  `/api/monitors/${encodeURIComponent(item.id)}`
                ),
                MonitorResponse
              )
              .pipe(Effect.map(toCurrentMonitor))
          : Effect.succeed({
              id: item.id,
              key: item.key,
              managed: item.managed,
              name: item.name,
            } satisfies CurrentMonitor),
      { concurrency: 8 }
    );
    return { channels, monitors } satisfies Current;
  });

const applyPlan = (api: Api, plan: Plan, current: Current) =>
  Effect.gen(function* applyPlanEffect() {
    const channelIds = new Map(
      current.channels.map((channel) => [channel.key, channel.id] as const)
    );
    const resolve = (refs: ChannelRefs): ChannelRefs =>
      refs === "all" ? refs : refs.map((key) => channelIds.get(key) ?? key);

    const run = (step: Step): Effect.Effect<void, SyncError> => {
      const label = describeStep(step);
      return Step.$match(step, {
        CreateChannel: ({ channel: { urlHash: _hash, ...channel } }) =>
          api
            .read(
              label,
              withBody(HttpClientRequest.post("/api/channels"), {
                ...channel,
                managed: true,
              }),
              ChannelView
            )
            .pipe(
              Effect.flatMap((created) =>
                Effect.sync(() => {
                  channelIds.set(created.key, created.id);
                })
              )
            ),
        CreateMonitor: ({ monitor }) =>
          api.call(
            label,
            withBody(HttpClientRequest.post("/api/monitors"), {
              ...monitor,
              channels: resolve(monitor.channels),
              managed: true,
            })
          ),
        DeleteChannel: ({ id }) =>
          api.call(
            label,
            HttpClientRequest.delete(`/api/channels/${encodeURIComponent(id)}`)
          ),
        DeleteMonitor: ({ id }) =>
          api.call(
            label,
            HttpClientRequest.delete(`/api/monitors/${encodeURIComponent(id)}`)
          ),
        UpdateChannel: ({ id, patch }) =>
          api.call(
            label,
            withBody(
              HttpClientRequest.patch(
                `/api/channels/${encodeURIComponent(id)}`
              ),
              patch
            )
          ),
        UpdateMonitor: ({ id, patch }) =>
          api.call(
            label,
            withBody(
              HttpClientRequest.patch(
                `/api/monitors/${encodeURIComponent(id)}`
              ),
              patch.channels === undefined
                ? patch
                : { ...patch, channels: resolve(patch.channels) }
            )
          ),
      });
    };

    for (const [applied, step] of plan.steps.entries()) {
      yield* run(step).pipe(
        Effect.mapError(
          (cause) =>
            new SyncError({
              message: `${cause.message}\n${applied} of ${plan.steps.length} change(s) were applied before the failure; fix it and run sync again.`,
            })
        )
      );
      yield* Console.log(`  done: ${describeStep(step)}`);
    }
    return plan.steps.length;
  });

const configErrors = (errors: readonly string[]) =>
  new SyncError({ message: formatPlan({ errors, steps: [] }) });

/**
 * Sync the config to the Worker at `baseUrl`: print the plan (with
 * `Console`), then apply it (unless `dryRun`). Channel URLs written as
 * `env("NAME")` are read with `Config` from the current `ConfigProvider`.
 * Fails with `SyncError` on config errors (before changing anything) and
 * on the first failed step.
 */
export const sync = Effect.fn("kanshi.sync")(function* syncEffect(
  options: SyncOptions
) {
  const resolved = yield* resolveDesired(options.config);
  if (resolved.errors.length > 0) {
    return yield* configErrors(resolved.errors);
  }
  const { desired } = resolved;
  const api = yield* makeApi(options);
  const current = yield* loadCurrent(api, desired, options.waitSeconds ?? 0);
  const plan = diff(desired, current, { adopt: options.adopt ?? false });
  if (plan.errors.length > 0) {
    return yield* configErrors(plan.errors);
  }
  yield* Console.log(formatPlan(plan));
  if (options.dryRun === true || plan.steps.length === 0) {
    return { applied: 0, plan } satisfies SyncResult;
  }
  const applied = yield* applyPlan(api, plan, current);
  yield* Console.log(`Applied ${applied} change(s).`);
  return { applied, plan } satisfies SyncResult;
});
