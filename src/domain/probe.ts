import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { errorCause, exchange, readPrefix, userAgent } from "../http/client.ts";
import { matchesExpectedStatus } from "./expected-status.ts";
import type { CheckErrorKind, MonitorMethod, ProbeOutcome } from "./monitor.ts";

export const maxBodyBytes = 1024 * 1024;

export interface ProbeRequest {
  readonly bodyContains: string | null;
  readonly expectedStatus: string;
  readonly method: MonitorMethod;
  readonly timeoutMs: number;
  readonly url: string;
}

const errorText = (cause: unknown, depth = 0): string => {
  if (depth >= 5) {
    return "";
  }
  if (cause instanceof Error) {
    return `${cause.name} ${cause.message} ${errorText(cause.cause, depth + 1)}`;
  }
  return Predicate.isString(cause) ? cause : "";
};

/**
 * Map what a failed request threw (the `fetch` rejection, or the error
 * that ended the body read) to a check error kind.
 */
export const classifyFetchError = (cause: unknown): CheckErrorKind => {
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

const failure = (
  errorKind: CheckErrorKind,
  message: string,
  status: number | null = null,
  latencyMs: number | null = null
): ProbeOutcome => ({ errorKind, latencyMs, message, ok: false, status });

/**
 * A pooled keep-alive connection closed by the target just as it was
 * reused. Retried once, immediately: it says nothing about the target.
 */
const isStaleConnection = (outcome: ProbeOutcome): boolean =>
  outcome.errorKind === "connection" &&
  /network connection lost/iu.test(outcome.message ?? "");

const transportFailure = (error: HttpClientError.HttpClientError) => {
  const cause = errorCause(error);
  return failure(classifyFetchError(cause), firstLine(cause));
};

/**
 * Probe a target once with the ambient `HttpClient`. Follows redirects,
 * gives up after `timeoutMs` (request, body and the retry together; the
 * fetch is aborted), reads at most 1 MB of the body (GET, or whenever
 * `bodyContains` is set) and never fails: every problem becomes a failed
 * {@link ProbeOutcome}.
 */
export const probe = Effect.fn("Probe.run")(function* probeEffect(
  request: ProbeRequest
) {
  const readBody = request.method === "GET" || request.bodyContains !== null;
  const httpRequest = HttpClientRequest.make(request.method)(request.url, {
    headers: { "user-agent": userAgent },
  });

  const attempt = Effect.gen(function* attemptEffect() {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* exchange(httpRequest, (response) =>
      Effect.gen(function* responseEffect() {
        const body = readBody
          ? yield* readPrefix(response, maxBodyBytes)
          : null;
        const finishedAt = yield* Clock.currentTimeMillis;
        return {
          body,
          latencyMs: Math.max(0, finishedAt - startedAt),
          status: response.status,
        };
      })
    );
  }).pipe(Effect.mapError(transportFailure));

  const result = yield* attempt.pipe(
    Effect.retry({ times: 1, while: isStaleConnection }),
    Effect.timeoutOption(request.timeoutMs),
    Effect.result
  );

  if (Result.isFailure(result)) {
    return result.failure;
  }
  if (Option.isNone(result.success)) {
    return failure("timeout", `no response within ${request.timeoutMs}ms`);
  }
  const { body, latencyMs, status } = result.success.value;
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
