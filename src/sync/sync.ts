// `kanshi sync`: load the current resources over the API, diff them with
// the config and apply the plan, one request at a time.
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { MonitorListItem, MonitorResponse } from "../api/spec.ts";
import type { KanshiConfig } from "../config.ts";
import { ChannelView } from "../domain/channel.ts";
import type { Environment } from "./desired.ts";
import { resolveDesired } from "./desired.ts";
import type {
  ChannelRefs,
  Current,
  CurrentMonitor,
  Plan,
  Step,
} from "./plan.ts";
import { describeStep, diff, formatPlan, monitorSettingKeys } from "./plan.ts";

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
  readonly environment: Environment;
  /** Called with each line of output (the plan, then progress). */
  readonly log: (line: string) => void;
  readonly token: string;
  /** Retry the first request for this long (the dev stack may be starting). */
  readonly waitSeconds?: number;
}

export interface SyncResult {
  /** Steps applied (0 on a dry run). */
  readonly applied: number;
  readonly plan: Plan;
}

const ErrorBody = Schema.Struct({ message: Schema.String });

const failure = (
  label: string,
  response: HttpClientResponse.HttpClientResponse
) =>
  response.text.pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) => {
      let detail = text;
      try {
        detail = Schema.decodeUnknownSync(ErrorBody)(JSON.parse(text)).message;
      } catch {
        // not a JSON error body; show it as is
      }
      const suffix = detail.length > 0 ? `: ${detail}` : "";
      return Effect.fail(
        new SyncError({
          message: `${label} failed with HTTP ${response.status}${suffix}`,
        })
      );
    })
  );

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

    const call = <A>(
      label: string,
      request: HttpClientRequest.HttpClientRequest,
      schema: Schema.Codec<A, unknown> | null
    ): Effect.Effect<A | null, SyncError> =>
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
          if (schema === null) {
            return Effect.succeed(null);
          }
          return response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
            Effect.mapError(
              (cause) =>
                new SyncError({
                  message: `${label}: unexpected response: ${cause.message}`,
                })
            )
          );
        })
      );

    const read = <A>(label: string, path: string, schema: Schema.Codec<A>) =>
      call(label, HttpClientRequest.get(path), schema).pipe(
        Effect.map((value) => value as A)
      );

    const send = <A>(
      label: string,
      request: HttpClientRequest.HttpClientRequest,
      body: unknown,
      schema: Schema.Codec<A> | null
    ) => call(label, HttpClientRequest.bodyJsonUnsafe(request, body), schema);

    return { call, read, send };
  });

type Api = Effect.Success<ReturnType<typeof makeApi>>;

const toCurrentMonitor = (monitor: MonitorResponse): CurrentMonitor => {
  const settings = Object.fromEntries(
    monitorSettingKeys.map((field) => [field, monitor[field]] as const)
  ) as unknown as NonNullable<CurrentMonitor["settings"]>;
  return {
    channels: monitor.channels,
    id: monitor.id,
    key: monitor.key,
    managed: monitor.managed,
    name: monitor.name,
    settings,
  };
};

/**
 * Channels and monitors as the API reports them. The full configuration
 * is only read for managed monitors and for monitors whose key is in the
 * config (the rest are only checked for key collisions).
 */
const loadCurrent = (
  api: Api,
  wantedKeys: ReadonlySet<string>,
  waitSeconds: number
) =>
  Effect.gen(function* loadCurrentEffect() {
    const listed = yield* api
      .read("GET /api/monitors", "/api/monitors", Schema.Array(MonitorListItem))
      .pipe(
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          times: waitSeconds,
          while: (error) => error.transport === true,
        })
      );
    const channels = yield* api.read(
      "GET /api/channels",
      "/api/channels",
      Schema.Array(ChannelView)
    );
    const monitors = yield* Effect.forEach(
      listed,
      (item) =>
        item.managed || wantedKeys.has(item.key)
          ? api
              .read(
                `GET /api/monitors/${item.id}`,
                `/api/monitors/${encodeURIComponent(item.id)}`,
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

const applyPlan = (
  api: Api,
  plan: Plan,
  current: Current,
  log: (line: string) => void
) =>
  Effect.gen(function* applyPlanEffect() {
    const channelIds = new Map(
      current.channels.map((channel) => [channel.key, channel.id] as const)
    );
    const resolve = (refs: ChannelRefs): ChannelRefs =>
      refs === "all" ? refs : refs.map((key) => channelIds.get(key) ?? key);

    const run = (step: Step): Effect.Effect<unknown, SyncError> => {
      const label = describeStep(step);
      switch (step._tag) {
        case "CreateChannel": {
          const { urlHash: _hash, ...channel } = step.channel;
          return api
            .send(
              label,
              HttpClientRequest.post("/api/channels"),
              { ...channel, managed: true },
              ChannelView
            )
            .pipe(
              Effect.tap((created) =>
                Effect.sync(() => {
                  if (created !== null) {
                    channelIds.set(created.key, created.id);
                  }
                })
              )
            );
        }
        case "UpdateChannel": {
          return api.send(
            label,
            HttpClientRequest.patch(
              `/api/channels/${encodeURIComponent(step.id)}`
            ),
            step.patch,
            null
          );
        }
        case "CreateMonitor": {
          return api.send(
            label,
            HttpClientRequest.post("/api/monitors"),
            {
              ...step.monitor,
              channels: resolve(step.monitor.channels),
              managed: true,
            },
            null
          );
        }
        case "UpdateMonitor": {
          return api.send(
            label,
            HttpClientRequest.patch(
              `/api/monitors/${encodeURIComponent(step.id)}`
            ),
            step.patch.channels === undefined
              ? step.patch
              : { ...step.patch, channels: resolve(step.patch.channels) },
            null
          );
        }
        case "DeleteMonitor": {
          return api.call(
            label,
            HttpClientRequest.delete(
              `/api/monitors/${encodeURIComponent(step.id)}`
            ),
            null
          );
        }
        case "DeleteChannel": {
          return api.call(
            label,
            HttpClientRequest.delete(
              `/api/channels/${encodeURIComponent(step.id)}`
            ),
            null
          );
        }
        default: {
          return step satisfies never;
        }
      }
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
      log(`  done: ${describeStep(step)}`);
    }
    return plan.steps.length;
  });

const configErrors = (errors: readonly string[]) =>
  new SyncError({ message: formatPlan({ errors, steps: [] }) });

/**
 * Sync the config to the Worker at `baseUrl`: print the plan, then apply
 * it (unless `dryRun`). Fails with `SyncError` on config errors (before
 * changing anything) and on the first failed step.
 */
export const sync = Effect.fn("kanshi.sync")(function* syncEffect(
  options: SyncOptions
) {
  const { log } = options;
  const resolved = yield* resolveDesired(options.config, options.environment);
  if (resolved.errors.length > 0) {
    return yield* configErrors(resolved.errors);
  }
  const { desired } = resolved;
  const api = yield* makeApi(options);
  const current = yield* loadCurrent(
    api,
    new Set(desired.monitors.map((monitor) => monitor.key)),
    options.waitSeconds ?? 0
  );
  const plan = diff(desired, current, { adopt: options.adopt ?? false });
  if (plan.errors.length > 0) {
    return yield* configErrors(plan.errors);
  }
  log(formatPlan(plan));
  if (options.dryRun === true || plan.steps.length === 0) {
    return { applied: 0, plan } satisfies SyncResult;
  }
  const applied = yield* applyPlan(api, plan, current, log);
  log(`Applied ${applied} change(s).`);
  return { applied, plan } satisfies SyncResult;
});
