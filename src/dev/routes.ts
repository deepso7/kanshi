import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import type { Monitor } from "../monitor/monitor.ts";
import type { Registry } from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";

export interface DevDeps {
  readonly monitors: Effect.Success<typeof Monitor>;
  readonly registries: Effect.Success<typeof Registry>;
}

const statusParam = (value: string | null, fallback: number): number => {
  const status = Number(value ?? fallback);
  return Number.isInteger(status) && status >= 200 && status <= 599
    ? status
    : fallback;
};

const maxDelayMs = 60_000;

const monitorNotFound = () =>
  Effect.succeed(HttpServerResponse.text("monitor not found", { status: 404 }));

/**
 * Dev stage fixtures under `/_dev/*` (never routed outside the dev stage):
 *
 * - `GET /_dev/target?status=500&delay=2000&body=...` fake target
 * - `GET /_dev/target/flip/:name` 200 while up, 503 while down;
 *   `POST` with `?up=true|false` sets it, without toggles it
 * - `POST /_dev/webhook?fail=500&failTimes=1&tag=x` alert sink, recorded
 *   in `dev_events` and logged; `GET /_dev/events` lists them
 * - `GET /_dev/registry` every Registry row, whatever its lifecycle
 * - `GET /_dev/monitors/:id` a monitor's raw status, checks, incidents and
 *   alert rows (notifications, recipients, outbox)
 * - `POST /_dev/monitors/:id/maintain?now=<ms>` run maintenance (rollups,
 *   retention) as of `now` (default: the current time), due or not
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

/** One console line for a received alert, whatever the channel format. */
const alertSummary = (url: URL, body: string): string => {
  const title = url.searchParams.get("title");
  let text = body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const found = [parsed.text, parsed.content].find(
      (value) => typeof value === "string"
    );
    text = typeof found === "string" ? found : body;
  } catch {
    // Not JSON (ntfy): the body is the message.
  }
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
      const nowParam = Number(url.searchParams.get("now") ?? Number.NaN);
      const now = Number.isFinite(nowParam) ? nowParam : Date.now();
      return yield* deps.monitors
        .getByName(id)
        .maintain(now)
        .pipe(
          Effect.flatMap((result) => HttpServerResponse.json(result)),
          Effect.catchTags({
            MonitorNotConfigured: monitorNotFound,
            MonitorTombstoned: monitorNotFound,
          })
        );
    });

  return Effect.gen(function* devRoutes() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://internal");
    const [area, first, second] = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(1);
    const get = request.method === "GET" || request.method === "HEAD";

    if (area === "target" && first === undefined) {
      return yield* target(url);
    }
    if (area === "target" && first === "flip" && second !== undefined) {
      return yield* flip(request.method, url, second);
    }
    if (area === "webhook" && request.method === "POST") {
      return yield* webhook(request, url);
    }
    if (area === "events" && get) {
      return yield* HttpServerResponse.json(yield* registry().devEvents());
    }
    if (area === "registry" && get) {
      return yield* HttpServerResponse.json(yield* registry().list());
    }
    if (area === "monitors" && first !== undefined && get) {
      return yield* monitorDetail(first);
    }
    if (
      area === "monitors" &&
      first !== undefined &&
      second === "maintain" &&
      request.method === "POST"
    ) {
      return yield* maintain(first, url);
    }
    return HttpServerResponse.empty({ status: 404 });
  });
};
