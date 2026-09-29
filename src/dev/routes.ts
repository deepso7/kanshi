import type { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as HttpBody from "effect/unstable/http/HttpBody";
import type * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { isLoopback } from "../domain/url.ts";
import { matchPattern } from "../http/route.ts";
import { Monitor } from "../monitor/monitor.ts";
import { Registry, registryName } from "../registry/registry.ts";
import { runWatchdog } from "../watchdog/run.ts";

export interface DevDeps {
  readonly monitors: Effect.Success<typeof Monitor>;
  readonly registries: Effect.Success<typeof Registry>;
}

/**
 * Whether a request's `Host` header names a loopback host. `/_dev/*` is
 * only served to such requests, so a dev-mode Worker that somehow reached
 * Cloudflare (whose hostnames are never loopback) still hides it.
 */
export const isLoopbackHost = (host: string | undefined): boolean => {
  if (host === undefined || !URL.canParse(`http://${host}`)) {
    return false;
  }
  const { hostname } = new URL(`http://${host}`);
  return isLoopback(hostname.toLowerCase());
};

const statusParam = (value: string | null, fallback: number): number => {
  const status = Number(value ?? fallback);
  return Number.isInteger(status) && status >= 200 && status <= 599
    ? status
    : fallback;
};

const maxDelayMs = 60_000;

const nowParam = (url: URL): number => {
  const value = Number(url.searchParams.get("now") ?? Number.NaN);
  return Number.isFinite(value) ? value : Date.now();
};

type Method = "ANY" | "GET" | "POST";

interface RouteInput {
  /** The `:name` segments of the pattern, in order. */
  readonly params: readonly string[];
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}

const param = (input: RouteInput, index = 0): string =>
  input.params[index] ?? "";

const methodMatches = (method: Method, actual: string): boolean =>
  method === "ANY" ||
  actual === method ||
  (method === "GET" && actual === "HEAD");

/** The API's `NotFound` body. */
const NotFoundBody = Schema.TaggedStruct("NotFound", {
  message: Schema.String,
});

const monitorNotFound = () =>
  HttpServerResponse.json(NotFoundBody.make({ message: "monitor not found" }), {
    status: 404,
  });

/**
 * Dev stage fixtures under `/_dev/*` (never routed outside the dev stage):
 *
 * - `GET /_dev/target?status=500&delay=2000&body=...` fake target
 * - `GET /_dev/target/flip/:name` 200 while up, 503 while down;
 *   `POST` with `?up=true|false` sets it, without toggles it
 * - `POST /_dev/webhook?fail=500&failTimes=1&tag=x` alert sink, recorded
 *   in `dev_events` and logged; `GET /_dev/events` lists them
 * - `GET /_dev/registry` every Registry row, whatever its lifecycle
 * - `GET /_dev/registry/calls` Registry calls per method (RPCs and alarm
 *   runs) since the Registry object started, with its instance id
 * - `GET /_dev/monitors/:id` a monitor's raw status, checks, incidents and
 *   alert rows (notifications, recipients, outbox)
 * - `POST /_dev/monitors/:id/maintain?now=<ms>` run maintenance (rollups,
 *   retention) as of `now` (default: the current time), due or not
 * - `POST /_dev/monitors/:id/clear-alarm` delete the monitor's alarm (as if
 *   lost); only the watchdog brings it back
 * - `POST /_dev/registry/:id/mark-deleting` mark a row `deleting` without
 *   deleting the monitor (a stuck delete)
 * - `POST /_dev/registry/:id/rewind` forget a row's summary (lost pushes)
 * - `POST /_dev/watchdog?now=<ms>` run the watchdog now, with `now` as its
 *   clock (default: the current time), and return its report;
 *   `GET /_dev/watchdog` lists its episodes and alert rows
 */
/** `GET /_dev/target?status=&delay=&body=` */
const target = (url: URL) =>
  Effect.gen(function* targetRoute() {
    const delayMs = Math.min(
      maxDelayMs,
      Math.max(0, Number(url.searchParams.get("delay") ?? 0) || 0)
    );
    if (delayMs > 0) {
      yield* Effect.sleep(delayMs);
    }
    const status = statusParam(url.searchParams.get("status"), 200);
    const body = url.searchParams.get("body") ?? (status < 400 ? "ok" : "down");
    return HttpServerResponse.text(body, { status });
  });

/** A JSON alert body's candidate message fields (Slack, Discord). */
const AlertBody = Schema.fromJsonString(
  Schema.Struct({
    content: Schema.optionalKey(Schema.Json),
    text: Schema.optionalKey(Schema.Json),
  })
);
const decodeAlertBody = Schema.decodeUnknownOption(AlertBody);

/** One console line for a received alert, whatever the channel format. */
const alertSummary = (url: URL, body: string): string => {
  const title = url.searchParams.get("title");
  // Not JSON (ntfy): the body is the message.
  const text = decodeAlertBody(body).pipe(
    Option.flatMap((parsed) =>
      Option.fromUndefinedOr(
        [parsed.text, parsed.content].find(Predicate.isString)
      )
    ),
    Option.getOrElse(() => body)
  );
  const line = [title, text]
    .filter(Boolean)
    .join(" | ")
    .replaceAll("\n", " | ");
  return line.slice(0, 300);
};

export const makeDevRoutes = (deps: DevDeps) => {
  const registry = () => deps.registries.getByName(registryName);

  const flip = (method: string, url: URL, name: string) =>
    Effect.gen(function* flipRoute() {
      if (method === "POST") {
        const upParam = url.searchParams.get("up");
        const up = yield* registry().setFlip(
          name,
          upParam === null ? null : upParam === "true"
        );
        yield* Effect.log(`dev flip target ${name} is ${up ? "up" : "down"}`);
        return yield* HttpServerResponse.json({ name, up });
      }
      const up = yield* registry().getFlip(name);
      return HttpServerResponse.text(up ? "up" : "down", {
        status: up ? 200 : 503,
      });
    });

  /**
   * `POST /_dev/webhook?fail=500&failTimes=2&tag=x`: records the alert and
   * answers `fail` (always, or for the first `failTimes` requests of `tag`).
   */
  const webhook = (request: HttpServerRequest.HttpServerRequest, url: URL) =>
    Effect.gen(function* webhookRoute() {
      const fail = url.searchParams.get("fail");
      const failTimes = Number(url.searchParams.get("failTimes") ?? Number.NaN);
      let failing = fail !== null;
      if (failing && Number.isInteger(failTimes)) {
        const tag = url.searchParams.get("tag") ?? url.search;
        const count = yield* registry().bumpDevCounter(`webhook:${tag}`);
        failing = count <= failTimes;
      }
      const status = failing ? statusParam(fail, 500) : 200;
      const body = yield* request.text;
      const id = yield* registry().recordDevEvent("webhook", {
        body,
        contentType: request.headers["content-type"] ?? null,
        idempotencyKey: request.headers["idempotency-key"] ?? null,
        path: url.pathname,
        query: url.search,
        respondedWith: status,
      });
      yield* Effect.log(
        `dev webhook #${id} (${status}) ${alertSummary(url, body)}`
      );
      return HttpServerResponse.text(status < 400 ? "ok" : "failed", {
        status,
      });
    });

  const monitorDetail = (id: string) =>
    Effect.gen(function* monitorRoute() {
      const monitor = deps.monitors.getByName(id);
      return yield* HttpServerResponse.json({
        alerts: yield* monitor.alerts(100),
        checks: yield* monitor.checks({ limit: 100 }),
        incidents: yield* monitor.incidents(100),
        status: yield* monitor.status(),
      });
    });

  const maintain = (id: string, url: URL) =>
    Effect.gen(function* maintainRoute() {
      return yield* deps.monitors
        .getByName(id)
        .maintain(nowParam(url))
        .pipe(
          Effect.flatMap((result) => HttpServerResponse.json(result)),
          Effect.catchTags({
            MonitorNotConfigured: monitorNotFound,
            MonitorTombstoned: monitorNotFound,
          })
        );
    });

  const registryAction = (id: string, action: string) =>
    Effect.gen(function* registryActionRoute() {
      if (action === "mark-deleting") {
        const marked = yield* registry().markDeleting(id, null);
        return yield* HttpServerResponse.json({ marked });
      }
      if (action === "rewind") {
        const rewound = yield* registry().devRewindSummary(id);
        return yield* HttpServerResponse.json({ rewound });
      }
      return HttpServerResponse.empty({ status: 404 });
    });

  const clearAlarm = (id: string) =>
    Effect.gen(function* clearAlarmRoute() {
      const monitor = deps.monitors.getByName(id);
      yield* monitor.devClearAlarm();
      return yield* HttpServerResponse.json(yield* monitor.status());
    });

  const routes: readonly (readonly [
    Method,
    string,
    (
      input: RouteInput
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      HttpBody.HttpBodyError | HttpServerError.HttpServerError,
      RuntimeContext
    >,
  ])[] = [
    ["ANY", "target", ({ url }) => target(url)],
    [
      "ANY",
      "target/flip/:name",
      (input) => flip(input.request.method, input.url, param(input)),
    ],
    ["POST", "webhook/*", ({ request, url }) => webhook(request, url)],
    [
      "GET",
      "events",
      () => Effect.flatMap(registry().devEvents(), HttpServerResponse.json),
    ],
    [
      "GET",
      "registry",
      () => Effect.flatMap(registry().list(), HttpServerResponse.json),
    ],
    [
      "GET",
      "registry/calls",
      () => Effect.flatMap(registry().devCalls(), HttpServerResponse.json),
    ],
    [
      "POST",
      "registry/:id/:action",
      (input) => registryAction(param(input), param(input, 1)),
    ],
    [
      "GET",
      "watchdog",
      () =>
        Effect.flatMap(registry().watchdogAlerts(100), HttpServerResponse.json),
    ],
    [
      "POST",
      "watchdog",
      ({ url }) =>
        Effect.flatMap(
          runWatchdog(deps, nowParam(url)),
          HttpServerResponse.json
        ),
    ],
    ["GET", "monitors/:id", (input) => monitorDetail(param(input))],
    [
      "POST",
      "monitors/:id/maintain",
      (input) => maintain(param(input), input.url),
    ],
    ["POST", "monitors/:id/clear-alarm", (input) => clearAlarm(param(input))],
  ];

  return Effect.gen(function* devRoutes() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://internal");
    const segments = url.pathname.split("/").filter(Boolean).slice(1);
    for (const [method, pattern, handle] of routes) {
      const params = matchPattern(pattern, segments);
      if (params !== null && methodMatches(method, request.method)) {
        return yield* handle({ params, request, url });
      }
    }
    return HttpServerResponse.empty({ status: 404 });
  });
};

/** The `/_dev/*` routes, built from the Worker's context. */
export class DevRoutes extends Context.Service<
  DevRoutes,
  ReturnType<typeof makeDevRoutes>
>()("kanshi/dev/DevRoutes") {
  static readonly layer = Layer.effect(
    DevRoutes,
    Effect.gen(function* DevRoutesLayer() {
      return makeDevRoutes({
        monitors: yield* Monitor,
        registries: yield* Registry,
      });
    })
  );
}
