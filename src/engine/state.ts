import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";

import { DatabaseClient } from "../db/client.ts";
import {
  alertChannels,
  alertDeliveries,
  incidents,
  monitors,
  relations,
} from "../db/schema.ts";
import type { CheckResult } from "../domain/check-result.ts";
import { DatabaseError } from "../domain/errors.ts";
import type { ClaimedMonitor } from "./scheduler.ts";

export type MonitorTransition = "down" | "none" | "up";

export interface StateDecision {
  readonly failureStreak: number;
  readonly status: "down" | "unknown" | "up";
  readonly successStreak: number;
  readonly transition: MonitorTransition;
}

export const evaluateCheck = (
  monitor: ClaimedMonitor,
  result: CheckResult
): StateDecision => {
  if (result.ok) {
    const successStreak = monitor.successStreak + 1;
    const status =
      monitor.status !== "up" && successStreak >= monitor.successThreshold
        ? "up"
        : monitor.status;

    return {
      failureStreak: 0,
      status,
      successStreak,
      transition: monitor.status === "down" && status === "up" ? "up" : "none",
    };
  }

  const failureStreak = monitor.failureStreak + 1;
  const status =
    monitor.status !== "down" && failureStreak >= monitor.failureThreshold
      ? "down"
      : monitor.status;

  return {
    failureStreak,
    status,
    successStreak: 0,
    transition:
      monitor.status !== "down" && status === "down" ? "down" : "none",
  };
};

const incidentCause = (result: CheckResult): string => {
  if (result.errorKind !== null) {
    return result.errorKind;
  }
  if (result.status !== null) {
    return `unexpected_status:${result.status}`;
  }
  return "probe_failed";
};

export interface CommitCheckInput {
  readonly checkedAt: number;
  readonly monitor: ClaimedMonitor;
  readonly result: CheckResult;
}

export const commitCheck = Effect.fn("Monitors.commitCheck")(
  function* commitCheckEffect(input: CommitCheckInput) {
    const decision = evaluateCheck(input.monitor, input.result);
    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    const batchDb = drizzle(raw, { relations });
    const monitorStamp = and(
      eq(monitors.id, input.monitor.id),
      eq(monitors.revision, input.monitor.revision),
      eq(monitors.lastCheckId, input.result.checkId),
      isNull(monitors.deletedAt)
    );
    const updateState = batchDb
      .update(monitors)
      .set({
        failureStreak: decision.failureStreak,
        lastCheckId: input.result.checkId,
        status: decision.status,
        successStreak: decision.successStreak,
        updatedAt: input.checkedAt,
      })
      .where(
        and(
          eq(monitors.id, input.monitor.id),
          eq(monitors.revision, input.monitor.revision),
          isNull(monitors.deletedAt)
        )
      )
      .returning({ id: monitors.id });

    const runBatch = <T extends Parameters<typeof batchDb.batch>[0]>(
      statements: T
    ) =>
      Effect.tryPromise({
        catch: (cause) =>
          new DatabaseError({
            cause,
            operation: "monitors.commitCheck",
          }),
        try: () => batchDb.batch(statements),
      });

    if (decision.transition === "none") {
      const results = yield* runBatch([updateState]);
      return results[0].length === 1;
    }

    if (decision.transition === "down") {
      const incidentId = `${input.monitor.id}:${input.result.checkId}`;
      const insertIncident = batchDb
        .insert(incidents)
        .select(
          batchDb
            .select({
              cause: sql<string>`${incidentCause(input.result)}`.as("cause"),
              id: sql<string>`${incidentId}`.as("id"),
              lastHttpStatus: sql<number | null>`${input.result.status}`.as(
                "last_http_status"
              ),
              monitorId: monitors.id,
              openingCheckId: sql<string>`${input.result.checkId}`.as(
                "opening_check_id"
              ),
              startedAt: sql<number>`${input.checkedAt}`.as("started_at"),
            })
            .from(monitors)
            .where(monitorStamp)
        )
        .onConflictDoNothing({ target: incidents.id });
      const insertDeliveries = batchDb
        .insert(alertDeliveries)
        .select(
          batchDb
            .select({
              channelId: alertChannels.id,
              createdAt: sql<number>`${input.checkedAt}`.as("created_at"),
              eventKind: sql<"down">`'down'`.as("event_kind"),
              incidentId: incidents.id,
              state: sql<"pending">`'pending'`.as("state"),
              updatedAt: sql<number>`${input.checkedAt}`.as("updated_at"),
            })
            .from(incidents)
            .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
            .innerJoin(
              alertChannels,
              and(
                eq(alertChannels.monitorId, monitors.id),
                eq(alertChannels.enabled, true)
              )
            )
            .where(and(eq(incidents.id, incidentId), monitorStamp))
        )
        .onConflictDoNothing();
      const results = yield* runBatch([
        updateState,
        insertIncident,
        insertDeliveries,
      ]);
      return results[0].length === 1;
    }

    const incidentId = input.monitor.openIncidentId;
    if (incidentId === null) {
      return yield* new DatabaseError({
        cause: new Error("A down monitor has no open incident"),
        operation: "monitors.commitCheck",
      });
    }

    const closeIncident = batchDb
      .update(incidents)
      .set({
        closingCheckId: input.result.checkId,
        resolution: "recovered",
        resolvedAt: input.checkedAt,
      })
      .where(
        and(
          eq(incidents.id, incidentId),
          isNull(incidents.resolvedAt),
          exists(
            batchDb
              .select({ id: monitors.id })
              .from(monitors)
              .where(monitorStamp)
          )
        )
      );
    const insertRecoveryDeliveries = batchDb
      .insert(alertDeliveries)
      .select(
        batchDb
          .select({
            channelId: alertChannels.id,
            createdAt: sql<number>`${input.checkedAt}`.as("created_at"),
            eventKind: sql<"up">`'up'`.as("event_kind"),
            incidentId: incidents.id,
            state: sql<"pending">`'pending'`.as("state"),
            updatedAt: sql<number>`${input.checkedAt}`.as("updated_at"),
          })
          .from(incidents)
          .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
          .innerJoin(
            alertChannels,
            and(
              eq(alertChannels.monitorId, monitors.id),
              eq(alertChannels.enabled, true)
            )
          )
          .where(and(eq(incidents.id, incidentId), monitorStamp))
      )
      .onConflictDoNothing();
    const results = yield* runBatch([
      updateState,
      closeIncident,
      insertRecoveryDeliveries,
    ]);
    return results[0].length === 1;
  }
);
