import * as Effect from "effect/Effect";
import { constTrue } from "effect/Function";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/** Sent with every probe and alert delivery. */
export const userAgent = "Kanshi uptime monitor";

/** Options for the `fetch` behind {@link FetchHttpClient.layer}. */
const requestInit: globalThis.RequestInit = { redirect: "follow" };

/**
 * Send `request` with the ambient `HttpClient` and pass the response to
 * `use`. The request is scoped to this call: when `use` finishes, fails or
 * is interrupted (a timeout) the underlying fetch is aborted, so an unread
 * or partly read body never holds the connection. Redirects are followed.
 * Client tracing is off: no span carries a channel's secret URL and no
 * trace headers are added to requests to third parties.
 */
export const exchange = <A, E, R>(
  request: HttpClientRequest.HttpClientRequest,
  use: (
    response: HttpClientResponse.HttpClientResponse
  ) => Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | HttpClientError.HttpClientError,
  R | HttpClient.HttpClient
> =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => HttpClient.withScope(client).execute(request)),
    Effect.flatMap(use),
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, requestInit),
    Effect.provideService(HttpClient.TracerDisabledWhen, constTrue)
  );

/**
 * Read at most `limit` bytes of a response body; the body stream is
 * cancelled as soon as the limit is reached. A response without a body
 * reads as empty.
 */
export const readPrefix = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number
): Effect.Effect<Uint8Array, HttpClientError.HttpClientError> =>
  response.stream.pipe(
    Stream.mapAccum(
      () => 0,
      (size, chunk: Uint8Array) => {
        const bytes = chunk.subarray(0, limit - size);
        const total = size + bytes.byteLength;
        return [total, [{ bytes, total }]] as const;
      }
    ),
    Stream.takeUntil(({ total }) => total >= limit),
    Stream.runCollect,
    Effect.map((parts) => {
      const out = new Uint8Array(parts.at(-1)?.total ?? 0);
      for (const { bytes, total } of parts) {
        out.set(bytes, total - bytes.byteLength);
      }
      return out;
    }),
    Effect.catchReason("HttpClientError", "EmptyBodyError", () =>
      Effect.succeed(new Uint8Array(0))
    )
  );

/** `chunks` joined into one array. */
export const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * A best-effort {@link readPrefix}: appends each chunk it reads (at most
 * `limit` bytes in all) to `into` as it goes, and gives up after `ms` or on
 * a read error, cancelling the body. Never fails: succeeds with true when
 * the body ended or reached `limit`, false when it gave up, `into` then
 * holding what was read by then.
 */
export const readPrefixWithin = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
  ms: number,
  into: Uint8Array[]
): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    let size = 0;
    return response.stream.pipe(
      Stream.runForEachWhile((chunk: Uint8Array) =>
        Effect.sync(() => {
          const bytes = chunk.subarray(0, limit - size);
          into.push(bytes);
          size += bytes.byteLength;
          return size < limit;
        })
      ),
      Effect.catchReason(
        "HttpClientError",
        "EmptyBodyError",
        () => Effect.void
      ),
      Effect.timeoutOption(ms),
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false)
    );
  });

/**
 * What went wrong underneath an `HttpClientError`: the `fetch` rejection
 * (or body read error) it wraps, else the reason's own message (which
 * names the request's URL).
 */
export const errorCause = (
  error: HttpClientError.HttpClientError
): Error | string => {
  const { cause } = error.reason;
  if (cause instanceof Error) {
    return cause;
  }
  return cause === undefined ? error.reason.message : String(cause);
};
