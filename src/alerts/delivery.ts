import * as Effect from "effect/Effect";

import type { FetchLike } from "../domain/probe.ts";
import { readBounded } from "../domain/probe.ts";
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

export type DeliveryResult =
  | { readonly _tag: "Delivered"; readonly status: number }
  | {
      readonly _tag: "Failed";
      readonly error: string;
      /** Retrying cannot help (4xx other than 408/425/429). */
      readonly permanent: boolean;
      readonly status: number | null;
    };

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/**
 * POST an alert once. Never fails: network errors and timeouts are
 * retryable `Failed` results.
 */
export const deliver = Effect.fn("Alerts.deliver")(function* deliverEffect(
  request: AlertRequest,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = deliveryTimeoutMs
) {
  const result = yield* Effect.tryPromise({
    catch: errorMessage,
    try: async () => {
      const response = await fetchImpl(request.url, {
        body: request.body,
        headers: {
          "user-agent": "Kanshi uptime monitor",
          ...request.headers,
        },
        method: "POST",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (classifyStatus(response.status) === "delivered") {
        await response.body?.cancel().catch(() => null);
        return { status: response.status, text: "" };
      }
      // The endpoint is not trusted: never buffer its whole body.
      const bytes = await readBounded(response.body, errorBodyBytes).catch(
        () => new Uint8Array(0)
      );
      const text = new TextDecoder().decode(bytes);
      return { status: response.status, text: text.slice(0, errorBodyChars) };
    },
  }).pipe(Effect.result);

  if (result._tag === "Failure") {
    return {
      _tag: "Failed",
      error: result.failure,
      permanent: false,
      status: null,
    } satisfies DeliveryResult as DeliveryResult;
  }
  const { status, text } = result.success;
  const kind = classifyStatus(status);
  if (kind === "delivered") {
    return { _tag: "Delivered", status } satisfies DeliveryResult;
  }
  return {
    _tag: "Failed",
    error: `HTTP ${status}${text.length > 0 ? `: ${text}` : ""}`,
    permanent: kind === "permanent",
    status,
  } satisfies DeliveryResult;
});
