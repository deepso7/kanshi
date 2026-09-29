// Shared integration-test harness: each test file calls `setup(stage)` once
// at its top level. It runs the Worker locally (alchemy dev mode, offline)
// for that file and returns request helpers. Files run one after another,
// all on port 1337, so do not run them while `pnpm dev` is up.
import { expect } from "bun:test";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { MonitorResponse } from "../../src/api/spec.ts";
import { Notification, OutboxEntry } from "../../src/domain/alert.ts";
import { Check, IncidentWithAlerts } from "../../src/domain/history.ts";
import type { MonitorCreateInput } from "../../src/domain/monitor-input.ts";
import { MonitorSnapshot, MonitorSummary } from "../../src/domain/monitor.ts";
import { Lifecycle } from "../../src/registry/registry.ts";
import Stack, { apiToken } from "./alchemy.run.ts";

export type Method = "DELETE" | "GET" | "PATCH" | "POST";

export interface Reply {
  readonly body: unknown;
  readonly status: number;
}

/** A raw reply: redirects are not followed. */
export interface RawReply {
  readonly headers: Headers;
  readonly status: number;
  readonly text: string;
}

/** Decode a reply's JSON body with `schema`. */
export const bodyOf =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (reply: Reply) =>
    Schema.decodeUnknownEffect(schema)(reply.body);

/** `MonitorStatusView`, as the dev inspector returns it. */
const MonitorStatusView = Schema.Struct({
  alarmAt: Schema.NullOr(Schema.Number),
  snapshot: Schema.NullOr(MonitorSnapshot),
  tombstonedAt: Schema.NullOr(Schema.Number),
});

/** `MonitorAlertsView`, as the dev inspector returns it. */
const MonitorAlertsView = Schema.Struct({
  notifications: Schema.Array(Notification),
  outbox: Schema.Array(OutboxEntry),
  recipients: Schema.Array(
    Schema.Struct({ channelId: Schema.String, incidentId: Schema.String })
  ),
});

/** `GET /_dev/monitors/:id`: a monitor's status, alert rows and history. */
export const Detail = Schema.Struct({
  alerts: MonitorAlertsView,
  checks: Schema.Array(Check),
  incidents: Schema.Array(IncidentWithAlerts),
  status: MonitorStatusView,
});
export type Detail = typeof Detail.Type;

/** `RegistryEntry`, as `GET /_dev/registry` returns it. */
const RegistryEntry = Schema.Struct({
  createdAt: Schema.Number,
  id: Schema.String,
  key: Schema.String,
  lifecycle: Lifecycle,
  managed: Schema.Boolean,
  opId: Schema.String,
  public: Schema.Boolean,
  summary: MonitorSummary,
  summaryRevision: Schema.Number,
  updatedAt: Schema.Number,
  watch: Schema.Struct({
    episodeId: Schema.NullOr(Schema.String),
    staleRuns: Schema.Number,
  }),
});

/** A `/_dev/events` row for a request the `/_dev/webhook` sink received. */
export const SinkEvent = Schema.Struct({
  at: Schema.Number,
  detail: Schema.Struct({
    body: Schema.String,
    idempotencyKey: Schema.NullOr(Schema.String),
    query: Schema.String,
    respondedWith: Schema.Number,
  }),
  id: Schema.Number,
});
export type SinkEvent = typeof SinkEvent.Type;

/** The generic webhook alert body (`WebhookPayload`), as the sink got it. */
export const WebhookAlert = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.Literals(["checked", "down", "not_checked", "test", "up"]),
    id: Schema.String,
    monitor: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    recovered: Schema.Boolean,
    title: Schema.String,
  })
);

/** `{ message }`: an API error body. */
export const ErrorBody = Schema.Struct({ message: Schema.String });

/** Checks oldest first. */
export const checksOf = (value: Detail): readonly Check[] =>
  value.checks.toReversed();

export const statusOf = (value: Detail) => value.status.snapshot?.state.status;

/** Poll `effect` until `predicate` holds. */
export const waitFor = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  timeoutMs = 30_000
) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error(`timed out: ${label}`)),
    Effect.retry({
      schedule: Schedule.spaced("250 millis"),
      times: Math.ceil(timeoutMs / 250),
    })
  );

export const setup = (stage: string) => {
  const api = Test.make({
    dev: true,
    providers: Cloudflare.providers(),
    stage,
    state: Alchemy.localState(),
  });

  const stack = api.beforeAll(
    api
      .deploy(Stack)
      .pipe(Effect.tap(({ url }) => Test.getWhenReady(`${url}/_dev/target`))),
    { timeout: 180_000 }
  );
  api.afterAll.skipIf(!!process.env.NO_DESTROY)(api.destroy(Stack), {
    timeout: 180_000,
  });

  const send = Effect.fn("Test.send")(function* sendRequest(
    method: Method,
    path: string,
    options: {
      readonly auth?: string | null;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    } = {}
  ) {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const auth = options.auth === undefined ? apiToken : options.auth;
    let request = HttpClientRequest.make(method)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ ...options.headers })
    );
    if (auth !== null) {
      request = HttpClientRequest.setHeader(
        request,
        "authorization",
        `Bearer ${auth}`
      );
    }
    if (options.body !== undefined) {
      request = HttpClientRequest.bodyJsonUnsafe(request, options.body);
    }
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {
      body:
        text.length > 0
          ? yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Unknown)
            )(text)
          : null,
      status: response.status,
    } satisfies Reply;
  });

  /**
   * A request without the bearer token and without following redirects,
   * for the dashboard and the status page. `form` is sent url-encoded.
   */
  const raw = Effect.fn("Test.raw")(function* rawRequest(
    method: Method,
    path: string,
    options: {
      readonly form?: Readonly<Record<string, string>>;
      readonly headers?: Readonly<Record<string, string>>;
      /** A JSON body (instead of `form`). */
      readonly json?: Schema.Json;
      /** Send the body as a stream: chunked, without a `content-length`. */
      readonly streamed?: boolean;
    } = {}
  ) {
    const { url } = yield* stack;
    const headers = new Headers();
    let body: string | undefined;
    if (options.form !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    } else if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    }
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      headers.set(name, value);
    }
    const response = yield* Effect.promise(() =>
      fetch(`${url}${path}`, {
        body:
          options.streamed === true && body !== undefined
            ? new Blob([body]).stream()
            : body,
        duplex: "half",
        headers,
        method,
        redirect: "manual",
      })
    );
    const text = yield* Effect.promise(() => response.text());
    return {
      headers: response.headers,
      status: response.status,
      text,
    } satisfies RawReply;
  });

  const detail = (id: string) =>
    send("GET", `/_dev/monitors/${id}`).pipe(Effect.flatMap(bodyOf(Detail)));

  const registryRows = send("GET", "/_dev/registry").pipe(
    Effect.flatMap(bodyOf(Schema.Array(RegistryEntry)))
  );

  const create = Effect.fn("Test.create")(function* createMonitor(
    body: Partial<typeof MonitorCreateInput.Encoded>
  ) {
    const reply = yield* send("POST", "/api/monitors", {
      body: { name: "integration", ...body },
    });
    expect(reply.status).toBe(201);
    return yield* bodyOf(MonitorResponse)(reply);
  });

  const devUrl = (path: string) =>
    stack.pipe(Effect.map(({ url }) => `${url}/_dev${path}`));

  const setFlip = (name: string, up: boolean) =>
    send("POST", `/_dev/target/flip/${name}?up=${up}`, { auth: null });

  return {
    create,
    detail,
    devUrl,
    raw,
    registryRows,
    send,
    setFlip,
    stack,
    test: api.test,
  };
};
