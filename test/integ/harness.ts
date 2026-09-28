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
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { MonitorResponse } from "../../src/api/spec.ts";
import type { MonitorStatusView } from "../../src/monitor/monitor.ts";
import type { CheckRow, IncidentRow } from "../../src/monitor/storage.ts";
import type { RegistryEntry } from "../../src/registry/registry.ts";
import Stack, { apiToken } from "./alchemy.run.ts";

export type Method = "DELETE" | "GET" | "PATCH" | "POST";

export interface Reply {
  readonly body: unknown;
  readonly status: number;
}

export interface Detail {
  readonly checks: readonly CheckRow[];
  readonly incidents: readonly IncidentRow[];
  readonly status: MonitorStatusView;
}

/** Checks oldest first. */
export const checksOf = (value: Detail): readonly CheckRow[] =>
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
      HttpClientRequest.setHeaders({
        ...options.headers,
        ...(auth === null ? {} : { authorization: `Bearer ${auth}` }),
      })
    );
    if (options.body !== undefined) {
      request = HttpClientRequest.bodyJsonUnsafe(request, options.body);
    }
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {
      body: text.length > 0 ? (JSON.parse(text) as unknown) : null,
      status: response.status,
    } satisfies Reply;
  });

  const detail = <D extends Detail = Detail>(id: string) =>
    send("GET", `/_dev/monitors/${id}`).pipe(
      Effect.map((reply) => reply.body as D)
    );

  const registryRows = send("GET", "/_dev/registry").pipe(
    Effect.map((reply) => reply.body as readonly RegistryEntry[])
  );

  const create = Effect.fn("Test.create")(function* createMonitor(
    body: Record<string, unknown>
  ) {
    const reply = yield* send("POST", "/api/monitors", {
      body: { name: "integration", ...body },
    });
    expect(reply.status).toBe(201);
    return reply.body as MonitorResponse;
  });

  const devUrl = (path: string) =>
    stack.pipe(Effect.map(({ url }) => `${url}/_dev${path}`));

  const setFlip = (name: string, up: boolean) =>
    send("POST", `/_dev/target/flip/${name}?up=${up}`, { auth: null });

  return {
    create,
    detail,
    devUrl,
    registryRows,
    send,
    setFlip,
    stack,
    test: api.test,
  };
};
