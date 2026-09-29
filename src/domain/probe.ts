import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { matchesExpectedStatus } from "./expected-status.ts";
import type { CheckErrorKind, MonitorMethod, ProbeOutcome } from "./monitor.ts";

export const maxBodyBytes = 1024 * 1024;

/** Grace period after the fetch timeout before the probe gives up itself. */
const hardTimeoutGraceMs = 1000;

export interface ProbeRequest {
  readonly bodyContains: string | null;
  readonly expectedStatus: string;
  readonly method: MonitorMethod;
  readonly timeoutMs: number;
  readonly url: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const errorText = (cause: unknown, depth = 0): string => {
  if (depth >= 5) {
    return "";
  }
  if (cause instanceof Error) {
    return `${cause.name} ${cause.message} ${errorText(cause.cause, depth + 1)}`;
  }
  return Predicate.isString(cause) ? cause : "";
};

/** Map a `fetch` rejection to a check error kind. */
export const classifyFetchError = (
  cause: unknown,
  timedOut: boolean
): CheckErrorKind => {
  if (timedOut) {
    return "timeout";
  }
  const text = errorText(cause).toLowerCase();
  if (/timeout|timed out/u.test(text)) {
    return "timeout";
  }
  if (/dns|enotfound|name not resolved|resolve host|getaddrinfo/u.test(text)) {
    return "dns";
  }
  if (/certificate|handshake|ssl|tls/u.test(text)) {
    return "tls";
  }
  if (/connect|connection|econn|refused|reset|unreachable/u.test(text)) {
    return "connection";
  }
  return "network";
};

const firstLine = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause))
    .split("\n", 1)[0]
    ?.slice(0, 200) ?? "";

/** Read at most `limit` bytes of a body, then cancel the rest. */
export const readBounded = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Uint8Array> => {
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be read in order
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const take = value.subarray(0, limit - size);
    chunks.push(take);
    size += take.byteLength;
  }
  await reader.cancel().catch(() => null);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const failure = (
  errorKind: CheckErrorKind,
  message: string,
  status: number | null = null,
  latencyMs: number | null = null
): ProbeOutcome => ({ errorKind, latencyMs, message, ok: false, status });

/**
 * Probe a target once. Follows redirects, times out after `timeoutMs`, reads
 * at most 1 MB of the body (GET, or whenever `bodyContains` is set) and
 * never fails: every problem becomes a failed {@link ProbeOutcome}.
 */
/**
 * A pooled keep-alive connection closed by the target just as it was
 * reused. Retried once, immediately: it says nothing about the target.
 */
const isStaleConnection = (outcome: ProbeOutcome): boolean =>
  outcome.errorKind === "connection" &&
  /network connection lost/iu.test(outcome.message ?? "");

export const probe = Effect.fn("Probe.run")(function* probeEffect(
  request: ProbeRequest,
  fetchImpl: FetchLike = fetch
) {
  const signal = AbortSignal.timeout(request.timeoutMs);
  const readBody = request.method === "GET" || request.bodyContains !== null;

  const attempt = Effect.tryPromise({
    catch: (cause) =>
      failure(classifyFetchError(cause, signal.aborted), firstLine(cause)),
    try: async () => {
      const startedAt = Date.now();
      const response = await fetchImpl(request.url, {
        headers: { "user-agent": "Kanshi uptime monitor" },
        method: request.method,
        redirect: "follow",
        signal,
      });
      if (!readBody) {
        await response.body?.cancel().catch(() => null);
        return {
          body: null,
          latencyMs: Date.now() - startedAt,
          status: response.status,
        };
      }
      const bytes = await readBounded(response.body, maxBodyBytes);
      return {
        body: bytes,
        latencyMs: Date.now() - startedAt,
        status: response.status,
      };
    },
  });

  const result = yield* attempt.pipe(
    Effect.retry({
      times: 1,
      while: (outcome) => isStaleConnection(outcome) && !signal.aborted,
    }),
    Effect.timeoutOption(request.timeoutMs + hardTimeoutGraceMs),
    Effect.map(
      Option.getOrElse(() => ({
        body: null,
        latencyMs: 0,
        status: -1,
      }))
    ),
    Effect.result
  );

  if (Result.isFailure(result)) {
    return result.failure;
  }
  const { body, status } = result.success;
  const latencyMs = Math.max(0, result.success.latencyMs);
  if (status === -1) {
    return failure("timeout", `no response within ${request.timeoutMs}ms`);
  }
  if (!matchesExpectedStatus(request.expectedStatus, status)) {
    return failure(
      "status",
      `expected ${request.expectedStatus}, got ${status}`,
      status,
      latencyMs
    );
  }
  if (request.bodyContains !== null) {
    const text = new TextDecoder().decode(body ?? new Uint8Array(0));
    if (!text.includes(request.bodyContains)) {
      return failure(
        "keyword",
        "response body does not contain the expected text",
        status,
        latencyMs
      );
    }
  }
  return {
    errorKind: null,
    latencyMs,
    message: null,
    ok: true,
    status,
  } satisfies ProbeOutcome;
});
