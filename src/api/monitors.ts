import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DatabaseClient } from "../db/client.ts";
import { alertChannels, incidents, monitors, relations } from "../db/schema.ts";
import { Monitor } from "../domain/monitor.ts";
import { DatabaseError, MonitorNotFound } from "../domain/errors.ts";
import {
  UrlValidationError,
  validateProbeUrl,
  validateWebhookUrl,
} from "../domain/url.ts";
import type {
  CreateChannelPayload,
  CreateMonitorPayload,
  UpdateMonitorPayload,
} from "./spec.ts";

const monitorQuota = 100;
const urlValidationTimeoutMs = 5000;

type CreateMonitorInput = typeof CreateMonitorPayload.Type;
type UpdateMonitorInput = typeof UpdateMonitorPayload.Type;
type CreateChannelInput = typeof CreateChannelPayload.Type;

const mapDatabaseError =
  (operation: string) =>
  (cause: unknown): DatabaseError =>
    new DatabaseError({ cause, operation });

// HttpApi encodes Schema.Class via encode(), which requires a class instance —
// plain drizzle rows fail with Expected kanshi/domain/Monitor.
const toMonitor = (row: unknown) =>
  Schema.decodeUnknownEffect(Monitor)(row).pipe(
    Effect.mapError(mapDatabaseError("monitors.decode"))
  );
const validateMonitorUrl = Effect.fn("Api.Monitors.validateUrl")(
  function* validateMonitorUrlEffect(input: string, allowHttp: boolean) {
    const result = yield* validateProbeUrl(input, { allowHttp }).pipe(
      Effect.timeoutOption(urlValidationTimeoutMs)
    );
    if (Option.isNone(result)) {
      return yield* new UrlValidationError({
        hostname: "",
        reason: "dns_resolver_failed",
      });
    }
    return result.value;
  }
);

export const listMonitors = Effect.fn("Api.Monitors.list")(
  function* listMonitorsEffect() {
    const { db } = yield* DatabaseClient;
    const rows = yield* db
      .select()
      .from(monitors)
      .where(isNull(monitors.deletedAt))
      .orderBy(asc(monitors.createdAt))
      .pipe(Effect.mapError(mapDatabaseError("monitors.list")));
    return yield* Effect.forEach(rows, toMonitor);
  }
);

export const getMonitor = Effect.fn("Api.Monitors.get")(
  function* getMonitorEffect(id: string) {
    const { db } = yield* DatabaseClient;
    const [monitor] = yield* db
      .select()
      .from(monitors)
      .where(and(eq(monitors.id, id), isNull(monitors.deletedAt)))
      .limit(1)
      .pipe(Effect.mapError(mapDatabaseError("monitors.get")));

    return monitor
      ? yield* toMonitor(monitor)
      : yield* new MonitorNotFound({ monitorId: id });
  }
);

export const createMonitor = Effect.fn("Api.Monitors.create")(
  function* createMonitorEffect(input: CreateMonitorInput, now: number) {
    const allowHttp = input.allowHttp ?? false;
    const url = yield* validateMonitorUrl(input.url, allowHttp);
    const id = crypto.randomUUID();
    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    const db = drizzle(raw, { relations });
    const statement = db
      .insert(monitors)
      .select(
        db
          .select({
            allowHttp: sql<boolean>`${allowHttp}`.as("allow_http"),
            createdAt: sql<number>`${now}`.as("created_at"),
            enabled: sql<boolean>`true`.as("enabled"),
            expectedStatus: sql<number>`${input.expectedStatus ?? 200}`.as(
              "expected_status"
            ),
            failureStreak: sql<number>`0`.as("failure_streak"),
            failureThreshold: sql<number>`${input.failureThreshold ?? 2}`.as(
              "failure_threshold"
            ),
            id: sql<string>`${id}`.as("id"),
            intervalSeconds: sql<number>`${input.intervalSeconds ?? 60}`.as(
              "interval_seconds"
            ),
            method: sql<"GET" | "HEAD">`${input.method ?? "GET"}`.as("method"),
            name: sql<string>`${input.name}`.as("name"),
            nextCheckAt: sql<number>`${now}`.as("next_check_at"),
            revision: sql<number>`1`.as("revision"),
            status: sql<"unknown">`'unknown'`.as("status"),
            successStreak: sql<number>`0`.as("success_streak"),
            successThreshold: sql<number>`${input.successThreshold ?? 1}`.as(
              "success_threshold"
            ),
            timeoutMs: sql<number>`${input.timeoutMs ?? 10_000}`.as(
              "timeout_ms"
            ),
            updatedAt: sql<number>`${now}`.as("updated_at"),
            url: sql<string>`${url.toString()}`.as("url"),
          })
          .from(sql`(select 1)`)
          .where(
            sql`(select count(*) from ${monitors} where ${monitors.deletedAt} is null) < ${monitorQuota}`
          )
      )
      .returning();
    const [created] = yield* Effect.tryPromise({
      catch: mapDatabaseError("monitors.create"),
      try: () => statement,
    });

    return created === undefined ? null : yield* toMonitor(created);
  }
);

const probeAffectingKeys: readonly (keyof UpdateMonitorInput)[] = [
  "allowHttp",
  "expectedStatus",
  "failureThreshold",
  "intervalSeconds",
  "method",
  "successThreshold",
  "timeoutMs",
  "url",
];

export const updateMonitor = Effect.fn("Api.Monitors.update")(
  function* updateMonitorEffect(
    id: string,
    input: UpdateMonitorInput,
    now: number
  ) {
    const current = yield* getMonitor(id);
    const probeAffecting = probeAffectingKeys.some((key) => key in input);
    const disabling = current.enabled && input.enabled === false;
    const enabling = !current.enabled && input.enabled === true;
    const bumpRevision = probeAffecting || disabling || enabling;
    const allowHttp = input.allowHttp ?? current.allowHttp;
    const url =
      "url" in input || "allowHttp" in input
        ? (yield* validateMonitorUrl(
            input.url ?? current.url,
            allowHttp
          )).toString()
        : current.url;
    const revision = current.revision + (bumpRevision ? 1 : 0);
    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    const db = drizzle(raw, { relations });
    const update = db
      .update(monitors)
      .set({
        allowHttp,
        enabled: input.enabled,
        expectedStatus: input.expectedStatus,
        failureStreak: bumpRevision ? 0 : undefined,
        failureThreshold: input.failureThreshold,
        intervalSeconds: input.intervalSeconds,
        method: input.method,
        name: input.name,
        nextCheckAt: enabling || probeAffecting ? now : undefined,
        revision,
        status: disabling || enabling ? "unknown" : undefined,
        successStreak: bumpRevision ? 0 : undefined,
        successThreshold: input.successThreshold,
        timeoutMs: input.timeoutMs,
        updatedAt: now,
        url,
      })
      .where(
        and(
          eq(monitors.id, id),
          eq(monitors.revision, current.revision),
          isNull(monitors.deletedAt)
        )
      )
      .returning();

    if (!disabling) {
      const [updated] = yield* Effect.tryPromise({
        catch: mapDatabaseError("monitors.update"),
        try: () => update,
      });
      return updated
        ? yield* toMonitor(updated)
        : yield* new MonitorNotFound({ monitorId: id });
    }

    const closeIncident = db
      .update(incidents)
      .set({
        resolution: "disabled",
        resolvedAt: now,
      })
      .where(
        and(
          eq(incidents.monitorId, id),
          isNull(incidents.resolvedAt),
          exists(
            db
              .select({ id: monitors.id })
              .from(monitors)
              .where(
                and(
                  eq(monitors.id, id),
                  eq(monitors.revision, revision),
                  eq(monitors.enabled, false),
                  eq(monitors.status, "unknown"),
                  isNull(monitors.deletedAt)
                )
              )
          )
        )
      );
    const results = yield* Effect.tryPromise({
      catch: mapDatabaseError("monitors.disable"),
      try: () => db.batch([update, closeIncident]),
    });
    const disabled = results[0][0];
    return disabled
      ? yield* toMonitor(disabled)
      : yield* new MonitorNotFound({ monitorId: id });
  }
);

export const removeMonitor = Effect.fn("Api.Monitors.remove")(
  function* removeMonitorEffect(id: string, now: number) {
    const current = yield* getMonitor(id);
    const revision = current.revision + 1;
    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    const db = drizzle(raw, { relations });
    const remove = db
      .update(monitors)
      .set({
        deletedAt: now,
        enabled: false,
        failureStreak: 0,
        revision,
        status: "unknown",
        successStreak: 0,
        updatedAt: now,
      })
      .where(
        and(
          eq(monitors.id, id),
          eq(monitors.revision, current.revision),
          isNull(monitors.deletedAt)
        )
      )
      .returning({ id: monitors.id });
    const closeIncident = db
      .update(incidents)
      .set({
        resolution: "deleted",
        resolvedAt: now,
      })
      .where(
        and(
          eq(incidents.monitorId, id),
          isNull(incidents.resolvedAt),
          exists(
            db
              .select({ id: monitors.id })
              .from(monitors)
              .where(
                and(
                  eq(monitors.id, id),
                  eq(monitors.revision, revision),
                  eq(monitors.deletedAt, now)
                )
              )
          )
        )
      );
    const results = yield* Effect.tryPromise({
      catch: mapDatabaseError("monitors.remove"),
      try: () => db.batch([remove, closeIncident]),
    });

    if (results[0].length === 0) {
      return yield* new MonitorNotFound({ monitorId: id });
    }
  }
);

export const listChannels = Effect.fn("Api.Monitors.listChannels")(
  function* listChannelsEffect(monitorId: string) {
    yield* getMonitor(monitorId);
    const { db } = yield* DatabaseClient;
    return yield* db
      .select({
        enabled: alertChannels.enabled,
        id: alertChannels.id,
        kind: alertChannels.kind,
        monitorId: alertChannels.monitorId,
      })
      .from(alertChannels)
      .where(eq(alertChannels.monitorId, monitorId))
      .orderBy(asc(alertChannels.id))
      .pipe(Effect.mapError(mapDatabaseError("channels.list")));
  }
);

export const createChannel = Effect.fn("Api.Monitors.createChannel")(
  function* createChannelEffect(monitorId: string, input: CreateChannelInput) {
    const webhookUrl = yield* validateWebhookUrl(input.webhookUrl, input.kind);
    const id = crypto.randomUUID();
    const { d1 } = yield* DatabaseClient;
    const raw = yield* d1.raw;
    const db = drizzle(raw, { relations });
    const statement = db
      .insert(alertChannels)
      .select(
        db
          .select({
            enabled: sql<boolean>`true`.as("enabled"),
            id: sql<string>`${id}`.as("id"),
            kind: sql<"discord" | "slack">`${input.kind}`.as("kind"),
            monitorId: monitors.id,
            webhookUrl: sql<string>`${webhookUrl.toString()}`.as("webhook_url"),
          })
          .from(monitors)
          .where(and(eq(monitors.id, monitorId), isNull(monitors.deletedAt)))
      )
      .returning({
        enabled: alertChannels.enabled,
        id: alertChannels.id,
        kind: alertChannels.kind,
        monitorId: alertChannels.monitorId,
      });
    const [created] = yield* Effect.tryPromise({
      catch: mapDatabaseError("channels.create"),
      try: () => statement,
    });

    return created ?? (yield* new MonitorNotFound({ monitorId }));
  }
);

export const removeChannel = Effect.fn("Api.Monitors.removeChannel")(
  function* removeChannelEffect(monitorId: string, channelId: string) {
    const { db } = yield* DatabaseClient;
    const [removed] = yield* db
      .update(alertChannels)
      .set({ enabled: false })
      .where(
        and(
          eq(alertChannels.id, channelId),
          eq(alertChannels.monitorId, monitorId),
          eq(alertChannels.enabled, true)
        )
      )
      .returning({ id: alertChannels.id })
      .pipe(Effect.mapError(mapDatabaseError("channels.remove")));

    return removed !== undefined;
  }
);
