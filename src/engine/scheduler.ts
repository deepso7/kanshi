import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";

import { DatabaseClient } from "../db/client.ts";
import { incidents, monitors, relations } from "../db/schema.ts";
import { DatabaseError } from "../domain/errors.ts";

export interface DueMonitor {
  readonly allowHttp: boolean;
  readonly expectedStatus: number;
  readonly failureStreak: number;
  readonly failureThreshold: number;
  readonly id: string;
  readonly intervalSeconds: number;
  readonly method: "GET" | "HEAD";
  readonly nextCheckAt: number;
  readonly openIncidentId: string | null;
  readonly revision: number;
  readonly status: "down" | "unknown" | "up";
  readonly successStreak: number;
  readonly successThreshold: number;
  readonly timeoutMs: number;
  readonly url: string;
}

export const selectDueMonitors = Effect.fn("Monitors.selectDue")(
  function* selectDueMonitorsEffect(now: number, limit: number) {
    const { db } = yield* DatabaseClient;
    return yield* db
      .select({
        allowHttp: monitors.allowHttp,
        expectedStatus: monitors.expectedStatus,
        failureStreak: monitors.failureStreak,
        failureThreshold: monitors.failureThreshold,
        id: monitors.id,
        intervalSeconds: monitors.intervalSeconds,
        method: monitors.method,
        nextCheckAt: monitors.nextCheckAt,
        openIncidentId: incidents.id,
        revision: monitors.revision,
        status: monitors.status,
        successStreak: monitors.successStreak,
        successThreshold: monitors.successThreshold,
        timeoutMs: monitors.timeoutMs,
        url: monitors.url,
      })
      .from(monitors)
      .leftJoin(
        incidents,
        and(eq(incidents.monitorId, monitors.id), isNull(incidents.resolvedAt))
      )
      .where(
        and(
          eq(monitors.enabled, true),
          isNull(monitors.deletedAt),
          lte(monitors.nextCheckAt, now)
        )
      )
      .orderBy(asc(monitors.nextCheckAt))
      .limit(limit)
      .pipe(
        Effect.mapError(
          (cause) =>
            new DatabaseError({
              cause,
              operation: "monitors.selectDue",
            })
        )
      );
  }
);

export interface ClaimedMonitor extends DueMonitor {
  readonly claimedNextCheckAt: number;
}

export const claimMonitors = Effect.fn("Monitors.claim")(
  function* claimMonitorsEffect(
    dueMonitors: readonly DueMonitor[],
    now: number
  ) {
    if (dueMonitors.length === 0) {
      return [];
    }

    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    // Drizzle's Effect D1 driver does not expose batch(); use the standard
    // adapter over the same binding for typed, atomic claim statements.
    const batchDb = drizzle(raw, { relations });
    const claims = dueMonitors.map((monitor) => {
      const intervalMs = monitor.intervalSeconds * 1000;
      return {
        monitor,
        nextCheckAt: Math.max(
          monitor.nextCheckAt + intervalMs,
          now + intervalMs
        ),
      };
    });
    const statements = claims.map(({ monitor, nextCheckAt }) =>
      batchDb
        .update(monitors)
        .set({
          nextCheckAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(monitors.id, monitor.id),
            eq(monitors.revision, monitor.revision),
            eq(monitors.nextCheckAt, monitor.nextCheckAt),
            eq(monitors.enabled, true),
            isNull(monitors.deletedAt)
          )
        )
        .returning({ id: monitors.id })
    );
    const [firstStatement, ...remainingStatements] = statements;
    if (!firstStatement) {
      return [];
    }
    const results = yield* Effect.tryPromise({
      catch: (cause) =>
        new DatabaseError({
          cause,
          operation: "monitors.claim",
        }),
      try: () => batchDb.batch([firstStatement, ...remainingStatements]),
    });

    return claims.flatMap(
      ({ monitor, nextCheckAt }, index): ClaimedMonitor[] =>
        results[index]?.length === 1
          ? [
              {
                ...monitor,
                claimedNextCheckAt: nextCheckAt,
              },
            ]
          : []
    );
  }
);
