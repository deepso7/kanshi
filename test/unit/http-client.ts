import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/** One request the test client received. */
export interface Sent {
  readonly request: HttpClientRequest.HttpClientRequest;
  /** The `redirect` option `FetchHttpClient` would pass to `fetch`. */
  readonly redirect: globalThis.RequestInit["redirect"];
  /** Aborted when the caller is done with the request (or interrupted). */
  readonly signal: AbortSignal;
}

/**
 * A test `HttpClient` that answers each request with `respond`: a web
 * `Response`, or a failure standing in for a `fetch` rejection (wrapped in
 * a `TransportError`, as `FetchHttpClient` does). `respond` is an Effect,
 * so it can be slow (`Effect.sleep`, driven by `TestClock`) or hang.
 */
export const testHttpClient = (
  respond: (sent: Sent) => Effect.Effect<Response, unknown>
) => {
  const sent: Sent[] = [];
  const client = HttpClient.make((request, _url, signal, fiber) => {
    const exchange: Sent = {
      redirect: Context.getOrUndefined(
        fiber.context,
        FetchHttpClient.RequestInit
      )?.redirect,
      request,
      signal,
    };
    sent.push(exchange);
    return respond(exchange).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ cause, request }),
          })
      )
    );
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), sent };
};

/** Answer every request with `status` and a text body. */
export const answering = (status: number, body: string | null = "") =>
  testHttpClient(() => Effect.succeed(new Response(body, { status })));

/** Reject every request, as `fetch` does on a network error. */
export const rejecting = (cause: unknown) =>
  testHttpClient(() => Effect.fail(cause));

/** Never answer. */
export const hanging = () => testHttpClient(() => Effect.never);

/**
 * A body that never ends: each pull yields another `chunkBytes` of `fill`.
 * Reports how many chunks were pulled and whether it was cancelled.
 */
export const endlessBody = (chunkBytes: number, fill = "x") => {
  const chunk = new TextEncoder().encode(fill.repeat(chunkBytes));
  const seen = { cancelled: false, pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      seen.cancelled = true;
    },
    pull: (controller) => {
      seen.pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return { body, seen };
};
