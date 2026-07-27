import { and, eq, isNull } from "drizzle-orm";
import * as Effect from "effect/Effect";
import { HttpClientError } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import { DatabaseClient } from "../db/client.ts";
import { incidents, monitors } from "../db/schema.ts";
import { DatabaseError, MonitorNotFound } from "../domain/errors.ts";
import type { TinybirdReadConfig } from "../tinybird/client.ts";
import { queryEndpoint } from "../tinybird/client.ts";
import { HistoryRow, KanshiApi, UptimeRow } from "./spec.ts";

const getLiveStatus = Effect.fn("Api.Status.live")(
  function* getLiveStatusEffect(monitorId: string) {
    const { db } = yield* DatabaseClient;
    const [row] = yield* db
      .select({
        failureStreak: monitors.failureStreak,
        incidentCause: incidents.cause,
        incidentId: incidents.id,
        incidentStartedAt: incidents.startedAt,
        lastCheckId: monitors.lastCheckId,
        status: monitors.status,
        successStreak: monitors.successStreak,
      })
      .from(monitors)
      .leftJoin(
        incidents,
        and(eq(incidents.monitorId, monitors.id), isNull(incidents.resolvedAt))
      )
      .where(and(eq(monitors.id, monitorId), isNull(monitors.deletedAt)))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new DatabaseError({
              cause,
              operation: "status.live",
            })
        )
      );

    if (!row) {
      return yield* new MonitorNotFound({ monitorId });
    }

    return {
      failureStreak: row.failureStreak,
      lastCheckId: row.lastCheckId,
      openIncident:
        row.incidentId === null
          ? null
          : {
              cause: row.incidentCause ?? "unknown",
              id: row.incidentId,
              startedAt: row.incidentStartedAt ?? 0,
            },
      status: row.status,
      successStreak: row.successStreak,
    };
  }
);

const ensureMonitor = (monitorId: string) =>
  getLiveStatus(monitorId).pipe(Effect.asVoid);

const parseRange = (
  startInput: string,
  endInput: string
): { readonly end: string; readonly start: string } | undefined => {
  const start = new Date(startInput);
  const end = new Date(endInput);
  const duration = end.getTime() - start.getTime();
  return Number.isNaN(duration) ||
    duration <= 0 ||
    duration > 31 * 24 * 60 * 60 * 1000
    ? undefined
    : { end: end.toISOString(), start: start.toISOString() };
};

const analyticsError = (error: unknown) =>
  HttpClientError.isHttpClientError(error) &&
  error.reason._tag === "StatusCodeError" &&
  error.reason.response.status === 400
    ? Effect.fail(new HttpApiError.BadRequest())
    : Effect.die(error);

export const StatusApiLive = (tinybird: TinybirdReadConfig) =>
  HttpApiBuilder.group(KanshiApi, "status", (handlers) =>
    handlers
      .handle("live", ({ params }) =>
        getLiveStatus(params.id).pipe(
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("history", ({ params, query }) => {
        const range = parseRange(query.start, query.end);
        if (!range) {
          return Effect.fail(new HttpApiError.BadRequest());
        }

        return ensureMonitor(params.id).pipe(
          Effect.flatMap(() =>
            queryEndpoint(
              tinybird,
              "monitor_history",
              {
                cursor: query.cursor,
                end: range.end,
                limit: query.limit,
                monitor_id: params.id,
                start: range.start,
              },
              HistoryRow
            ).pipe(
              // oxlint-disable-next-line promise/prefer-await-to-then -- Effect error channel, not a Promise
              Effect.catch(analyticsError)
            )
          ),
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        );
      })
      .handle("uptime", ({ params, query }) => {
        const range = parseRange(query.start, query.end);
        if (!range) {
          return Effect.fail(new HttpApiError.BadRequest());
        }

        return ensureMonitor(params.id).pipe(
          Effect.flatMap(() =>
            queryEndpoint(
              tinybird,
              "monitor_uptime",
              {
                bucket: query.bucket,
                end: range.end,
                monitor_id: params.id,
                start: range.start,
              },
              UptimeRow
            ).pipe(
              // oxlint-disable-next-line promise/prefer-await-to-then -- Effect error channel, not a Promise
              Effect.catch(analyticsError)
            )
          ),
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        );
      })
  );
