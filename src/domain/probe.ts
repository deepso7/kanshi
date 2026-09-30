import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { errorCause, exchange, readPrefix, userAgent } from "../http/client.ts";
import { matchesExpectedStatus } from "./expected-status.ts";
import type {
  CheckErrorKind,
  MonitorMethod,
  ProbeOutcome,
  ResponseExcerpt,
} from "./monitor.ts";

export const maxBodyBytes = 1024 * 1024;
/** Bytes of a failed check's body kept as its response excerpt. */
export const excerptBytes = 2048;

export interface ProbeRequest {
  readonly bodyContains: string | null;
  readonly expectedStatus: string;
  readonly method: MonitorMethod;
  readonly timeoutMs: number;
  readonly url: string;
}

/** What a probe observed, with the start of the body of a failed response. */
export interface ProbeResult extends ProbeOutcome {
  /**
   * The start of the body when the check failed on its status or keyword
   * (null for a blank body); always null on success and on transport
   * errors.
   */
  readonly responseExcerpt: ResponseExcerpt | null;
}

/**
 * The first {@link excerptBytes} of `body` as UTF-8, or null when blank.
 * `truncated` when `body` is longer (read one byte past the limit to know).
 */
export const responseExcerpt = (body: Uint8Array): ResponseExcerpt | null => {
  // `stream` holds back a character cut at the limit instead of decoding
  // its first bytes as U+FFFD.
  const text = new TextDecoder().decode(body.subarray(0, excerptBytes), {
    stream: true,
  });
  return text.trim().length === 0
    ? null
    : { text, truncated: body.byteLength > excerptBytes };
};

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
  latencyMs: number | null = null,
  excerpt: ResponseExcerpt | null = null
): ProbeResult => ({
  errorKind,
  latencyMs,
  message,
  ok: false,
  responseExcerpt: excerpt,
  status,
});

/**
 * A pooled keep-alive connection closed by the target just as it was
 * reused. Retried once, immediately: it says nothing about the target.
 */
const isStaleConnection = (outcome: ProbeResult): boolean =>
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
 * {@link ProbeResult}.
 *
 * A check that fails on its status or keyword carries the first 2 KB of
 * the body as `responseExcerpt`. A failed status whose body is not read
 * otherwise (HEAD without a keyword) reads just those 2 KB, within the
 * same timeout; a successful one still leaves its body unread.
 *
 * Latency runs from the request to the end of the body the check needs
 * (none for HEAD without a keyword, else up to 1 MB); the extra excerpt
 * read of a failed status is not part of it.
 */
export const probe = Effect.fn("Probe.run")(function* probeEffect(
  request: ProbeRequest
): Effect.fn.Return<ProbeResult, never, HttpClient.HttpClient> {
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
        // Only the excerpt needs this read: failing it loses the excerpt,
        // not the check's result.
        const excerptBody =
          body === null &&
          !matchesExpectedStatus(request.expectedStatus, response.status)
            ? yield* readPrefix(response, excerptBytes + 1).pipe(
                Effect.orElseSucceed(() => new Uint8Array(0))
              )
            : null;
        return {
          body: body ?? excerptBody ?? new Uint8Array(0),
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
      latencyMs,
      responseExcerpt(body)
    );
  }
  if (request.bodyContains !== null) {
    const text = new TextDecoder().decode(body);
    if (!text.includes(request.bodyContains)) {
      return failure(
        "keyword",
        "response body does not contain the expected text",
        status,
        latencyMs,
        responseExcerpt(body)
      );
    }
  }
  return {
    errorKind: null,
    latencyMs,
    message: null,
    ok: true,
    responseExcerpt: null,
    status,
  } satisfies ProbeResult;
});
