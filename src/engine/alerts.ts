import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { DatabaseClient } from "../db/client.ts";
import {
  alertChannels,
  alertDeliveries,
  incidents,
  monitors,
  relations,
} from "../db/schema.ts";
import { DatabaseError } from "../domain/errors.ts";
import type { WebhookKind } from "../domain/url.ts";
import { UrlValidationError, validateWebhookUrl } from "../domain/url.ts";

const deliveryBatchSize = 20;
const deliveryConcurrency = 5;
const deliveryLeaseMs = 30_000;
const deliveryRequestTimeoutMs = 10_000;
const deliveryBudgetMs = 20_000;

interface DeliveryCandidate {
  readonly attempts: number;
  readonly cause: string;
  readonly channelId: string;
  readonly channelEnabled: boolean;
  readonly eventKind: "down" | "up";
  readonly incidentId: string;
  readonly kind: WebhookKind;
  readonly maxAttempts: number;
  readonly monitorId: string;
  readonly monitorName: string;
  readonly monitorUrl: string;
  readonly startedAt: number;
  readonly webhookUrl: string;
}

interface ClaimedDelivery extends DeliveryCandidate {
  readonly leaseUntil: number;
}

const selectClaimableDeliveries = Effect.fn("Alerts.selectClaimable")(
  function* selectClaimableDeliveriesEffect(now: number) {
    const { db } = yield* DatabaseClient;

    return yield* db
      .select({
        attempts: alertDeliveries.attempts,
        cause: incidents.cause,
        channelEnabled: alertChannels.enabled,
        channelId: alertDeliveries.channelId,
        eventKind: alertDeliveries.eventKind,
        incidentId: alertDeliveries.incidentId,
        kind: alertChannels.kind,
        maxAttempts: alertDeliveries.maxAttempts,
        monitorId: monitors.id,
        monitorName: monitors.name,
        monitorUrl: monitors.url,
        startedAt: incidents.startedAt,
        webhookUrl: alertChannels.webhookUrl,
      })
      .from(alertDeliveries)
      .innerJoin(alertChannels, eq(alertChannels.id, alertDeliveries.channelId))
      .innerJoin(incidents, eq(incidents.id, alertDeliveries.incidentId))
      .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
      .where(
        and(
          lt(alertDeliveries.attempts, alertDeliveries.maxAttempts),
          or(
            eq(alertDeliveries.state, "pending"),
            and(
              eq(alertDeliveries.state, "delivering"),
              lt(alertDeliveries.leaseUntil, now)
            )
          )
        )
      )
      .orderBy(asc(alertDeliveries.createdAt))
      .limit(deliveryBatchSize)
      .pipe(
        Effect.mapError(
          (cause) =>
            new DatabaseError({
              cause,
              operation: "alerts.selectClaimable",
            })
        )
      );
  }
);

const claimDeliveries = Effect.fn("Alerts.claim")(
  function* claimDeliveriesEffect(
    candidates: readonly DeliveryCandidate[],
    now: number
  ) {
    if (candidates.length === 0) {
      return [];
    }

    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    const batchDb = drizzle(raw, { relations });
    const leaseUntil = now + deliveryLeaseMs;
    const statements = candidates.map((candidate) =>
      batchDb
        .update(alertDeliveries)
        .set({
          attempts: sql`${alertDeliveries.attempts} + 1`,
          leaseUntil,
          state: "delivering",
          updatedAt: now,
        })
        .where(
          and(
            eq(alertDeliveries.incidentId, candidate.incidentId),
            eq(alertDeliveries.eventKind, candidate.eventKind),
            eq(alertDeliveries.channelId, candidate.channelId),
            lt(alertDeliveries.attempts, alertDeliveries.maxAttempts),
            or(
              eq(alertDeliveries.state, "pending"),
              and(
                eq(alertDeliveries.state, "delivering"),
                lt(alertDeliveries.leaseUntil, now)
              )
            )
          )
        )
        .returning({ attempts: alertDeliveries.attempts })
    );
    const [firstStatement, ...remainingStatements] = statements;
    if (!firstStatement) {
      return [];
    }

    const results = yield* Effect.tryPromise({
      catch: (cause) =>
        new DatabaseError({
          cause,
          operation: "alerts.claim",
        }),
      try: () => batchDb.batch([firstStatement, ...remainingStatements]),
    });

    return candidates.flatMap((candidate, index): ClaimedDelivery[] => {
      const claimed = results[index]?.[0];
      return claimed
        ? [
            {
              ...candidate,
              attempts: claimed.attempts,
              leaseUntil,
            },
          ]
        : [];
    });
  }
);

const messageFor = (delivery: ClaimedDelivery): string =>
  delivery.eventKind === "down"
    ? `🔴 ${delivery.monitorName} is down\n${delivery.monitorUrl}\nCause: ${delivery.cause}`
    : `🟢 ${delivery.monitorName} recovered\n${delivery.monitorUrl}\nIncident started: ${new Date(delivery.startedAt).toISOString()}`;

const sendWebhook = Effect.fn("Alerts.sendWebhook")(function* sendWebhookEffect(
  delivery: ClaimedDelivery
) {
  const url = yield* validateWebhookUrl(delivery.webhookUrl, delivery.kind);
  const client = yield* HttpClient.HttpClient;
  const payload =
    delivery.kind === "slack"
      ? { text: messageFor(delivery) }
      : { content: messageFor(delivery) };
  const response = yield* HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJsonUnsafe(payload),
    client.execute,
    Effect.provideService(FetchHttpClient.RequestInit, {
      redirect: "manual",
    }),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.timeoutOption(deliveryRequestTimeoutMs)
  );

  if (Option.isNone(response)) {
    return yield* Effect.fail(new Error("webhook_timeout"));
  }
});

const isRetryable = (error: unknown): boolean => {
  if (error instanceof UrlValidationError) {
    return error.reason === "dns_resolver_failed";
  }
  if (!HttpClientError.isHttpClientError(error)) {
    return error instanceof Error && error.message === "webhook_timeout";
  }
  if (error.reason._tag === "TransportError") {
    return true;
  }
  if (error.reason._tag !== "StatusCodeError") {
    return false;
  }

  const { status } = error.reason.response;
  return status === 408 || status === 425 || status === 429 || status >= 500;
};

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof UrlValidationError) {
    return `webhook_${error.reason}`;
  }
  if (HttpClientError.isHttpClientError(error)) {
    return error.reason._tag === "StatusCodeError"
      ? `http_${error.reason.response.status}`
      : error.reason._tag;
  }
  return error instanceof Error ? error.message.slice(0, 200) : "unknown_error";
};

const finalizeDelivery = Effect.fn("Alerts.finalize")(
  function* finalizeDeliveryEffect(
    delivery: ClaimedDelivery,
    outcome:
      | { readonly _tag: "Delivered" }
      | {
          readonly _tag: "Failed";
          readonly error: unknown;
          readonly retryable: boolean;
        },
    now: number
  ) {
    const { db } = yield* DatabaseClient;
    const exhausted = delivery.attempts >= delivery.maxAttempts;
    const delivered = outcome._tag === "Delivered";
    const permanentlyFailed =
      outcome._tag === "Failed" && (!outcome.retryable || exhausted);
    let state: "delivered" | "failed" | "pending" = "pending";
    if (delivered) {
      state = "delivered";
    } else if (permanentlyFailed) {
      state = "failed";
    }

    yield* db
      .update(alertDeliveries)
      .set({
        lastError: delivered ? null : safeErrorMessage(outcome.error),
        leaseUntil: null,
        state,
        updatedAt: now,
      })
      .where(
        and(
          eq(alertDeliveries.incidentId, delivery.incidentId),
          eq(alertDeliveries.eventKind, delivery.eventKind),
          eq(alertDeliveries.channelId, delivery.channelId),
          eq(alertDeliveries.state, "delivering"),
          eq(alertDeliveries.attempts, delivery.attempts),
          eq(alertDeliveries.leaseUntil, delivery.leaseUntil)
        )
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DatabaseError({
              cause,
              operation: "alerts.finalize",
            })
        )
      );
  }
);

const deliverClaimed = Effect.fn("Alerts.deliverClaimed")(
  function* deliverClaimedEffect(delivery: ClaimedDelivery) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* AlertDeliveryHandoff() {
        const attempt = yield* restore(
          delivery.channelEnabled
            ? sendWebhook(delivery)
            : Effect.fail(new Error("channel_disabled"))
        ).pipe(Effect.result);
        const now = yield* Clock.currentTimeMillis;

        if (Result.isSuccess(attempt)) {
          yield* finalizeDelivery(delivery, { _tag: "Delivered" }, now);
          return;
        }

        const retryable = isRetryable(attempt.failure);
        yield* finalizeDelivery(
          delivery,
          {
            _tag: "Failed",
            error: attempt.failure,
            retryable,
          },
          now
        );
        yield* Effect.logWarning("Alert delivery failed", {
          attempts: delivery.attempts,
          channelId: delivery.channelId,
          incidentId: delivery.incidentId,
          retryable,
        });
      })
    );
  }
);

export const deliverPendingAlerts = Effect.fn("Alerts.deliverPending")(
  function* deliverPendingAlertsEffect() {
    const startedAt = yield* Clock.currentTimeMillis;
    const candidates = yield* selectClaimableDeliveries(startedAt);
    let claimedCount = 0;

    for (
      let index = 0;
      index < candidates.length;
      index += deliveryConcurrency
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (now - startedAt >= deliveryBudgetMs) {
        yield* Effect.logWarning("Alert delivery start budget exhausted");
        break;
      }

      const claimed = yield* claimDeliveries(
        candidates.slice(index, index + deliveryConcurrency),
        now
      );
      claimedCount += claimed.length;
      // oxlint-disable-next-line unicorn/no-array-for-each -- this is Effect's bounded concurrent traversal
      yield* Effect.forEach(
        claimed,
        (delivery) =>
          deliverClaimed(delivery).pipe(
            Effect.catchTag("DatabaseError", (error) =>
              Effect.logError("Failed to finalize alert delivery", {
                channelId: delivery.channelId,
                incidentId: delivery.incidentId,
                operation: error.operation,
              })
            )
          ),
        {
          concurrency: deliveryConcurrency,
          discard: true,
        }
      );
    }

    yield* Effect.annotateCurrentSpan({
      "alerts.claimed_deliveries": claimedCount,
    });
  }
);
