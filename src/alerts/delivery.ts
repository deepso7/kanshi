import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { errorCause, exchange, readPrefix, userAgent } from "../http/client.ts";
import type { AlertRequest } from "./message.ts";

/** Attempts per outbox row before it is marked `failed`. */
export const maxAttempts = 8;
export const backoffBaseMs = 30_000;
export const backoffMaxMs = 30 * 60_000;
/** How long one delivery request may take. */
export const deliveryTimeoutMs = 10_000;
/** Bytes of a failed response's body read for the error message. */
export const errorBodyBytes = 1024;
/** Characters of that body kept in the error message. */
const errorBodyChars = 200;

/**
 * Delay before the next attempt after `attempts` failed ones (>= 1):
 * 30s, 1m, 2m, 4m, 8m, 16m, then 30m.
 */
export const backoffMs = (attempts: number): number =>
  Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempts - 1));

export type StatusClass = "delivered" | "permanent" | "retry";

/** Status codes that are 4xx but worth retrying. */
const retryable4xx = new Set([408, 425, 429]);

/**
 * 2xx is delivered; 4xx is permanent except 408, 425 and 429; anything
 * else (5xx, unexpected 1xx/3xx) is retried.
 */
export const classifyStatus = (status: number): StatusClass => {
  if (status >= 200 && status < 300) {
    return "delivered";
  }
  if (status >= 400 && status < 500 && !retryable4xx.has(status)) {
    return "permanent";
  }
  return "retry";
};

/** The outcome of one delivery attempt. */
export type DeliveryResult = Data.TaggedEnum<{
  Delivered: { readonly status: number };
  Failed: {
    readonly error: string;
    /** Retrying cannot help (4xx other than 408/425/429). */
    readonly permanent: boolean;
    readonly status: number | null;
  };
}>;

/**
 * Constructors (`DeliveryResult.Delivered`, `DeliveryResult.Failed`),
 * `$is` and `$match`.
 */
export const DeliveryResult = Data.taggedEnum<DeliveryResult>();

const errorMessage = (cause: Error | string): string =>
  (cause instanceof Error ? cause.message : cause).slice(0, 200);

/**
 * The status and, for a failed delivery, the start of the body. A
 * delivered response is discarded unread (leaving `exchange` aborts it);
 * the endpoint is not trusted, so a failed one's body is never buffered
 * whole.
 */
const readResponse = (response: HttpClientResponse.HttpClientResponse) =>
  classifyStatus(response.status) === "delivered"
    ? Effect.succeed({ status: response.status, text: "" })
    : readPrefix(response, errorBodyBytes).pipe(
        Effect.orElseSucceed(() => new Uint8Array(0)),
        Effect.map((bytes) => ({
          status: response.status,
          text: new TextDecoder().decode(bytes).slice(0, errorBodyChars),
        }))
      );

/**
 * POST an alert once with the ambient `HttpClient`. Never fails: network
 * errors and timeouts (`timeoutMs` for the request and the error body; the
 * fetch is aborted) are retryable `Failed` results.
 */
export const deliver = Effect.fn("Alerts.deliver")(function* deliverEffect(
  request: AlertRequest,
  timeoutMs: number = deliveryTimeoutMs
) {
  const httpRequest = HttpClientRequest.post(request.url).pipe(
    HttpClientRequest.bodyText(request.body),
    HttpClientRequest.setHeaders({
      "user-agent": userAgent,
      ...request.headers,
    })
  );
  const result = yield* exchange(httpRequest, readResponse).pipe(
    Effect.mapError((error) => errorMessage(errorCause(error))),
    Effect.timeoutOption(timeoutMs),
    Effect.result
  );

  if (Result.isFailure(result)) {
    return DeliveryResult.Failed({
      error: result.failure,
      permanent: false,
      status: null,
    });
  }
  if (Option.isNone(result.success)) {
    return DeliveryResult.Failed({
      error: `no response within ${timeoutMs}ms`,
      permanent: false,
      status: null,
    });
  }
  const { status, text } = result.success.value;
  const kind = classifyStatus(status);
  if (kind === "delivered") {
    return DeliveryResult.Delivered({ status });
  }
  return DeliveryResult.Failed({
    error: `HTTP ${status}${text.length > 0 ? `: ${text}` : ""}`,
    permanent: kind === "permanent",
    status,
  });
});
