/* oxlint-disable sort-keys -- column order mirrors the database contract */
import { defineRelations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const monitors = sqliteTable(
  "monitors",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    url: text().notNull(),
    method: text({ enum: ["GET", "HEAD"] })
      .notNull()
      .default("GET"),
    expectedStatus: integer("expected_status").notNull().default(200),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    failureThreshold: integer("failure_threshold").notNull().default(2),
    successThreshold: integer("success_threshold").notNull().default(1),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    revision: integer().notNull().default(1),
    status: text({ enum: ["unknown", "up", "down"] })
      .notNull()
      .default("unknown"),
    failureStreak: integer("failure_streak").notNull().default(0),
    successStreak: integer("success_streak").notNull().default(0),
    lastCheckId: text("last_check_id"),
    nextCheckAt: integer("next_check_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    check("monitors_method", sql`${table.method} in ('GET', 'HEAD')`),
    check(
      "monitors_expected_status",
      sql`${table.expectedStatus} between 100 and 599`
    ),
    check(
      "monitors_timeout_ms",
      sql`${table.timeoutMs} between 1000 and 30000`
    ),
    check(
      "monitors_interval_seconds",
      sql`${table.intervalSeconds} >= 60 and ${table.intervalSeconds} % 60 = 0`
    ),
    check(
      "monitors_failure_threshold",
      sql`${table.failureThreshold} between 1 and 10`
    ),
    check(
      "monitors_success_threshold",
      sql`${table.successThreshold} between 1 and 10`
    ),
    check("monitors_enabled", sql`${table.enabled} in (0, 1)`),
    check("monitors_status", sql`${table.status} in ('unknown', 'up', 'down')`),
    index("monitors_due").on(table.enabled, table.deletedAt, table.nextCheckAt),
  ]
);

export const incidents = sqliteTable(
  "incidents",
  {
    id: text().primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    openingCheckId: text("opening_check_id").notNull(),
    closingCheckId: text("closing_check_id"),
    startedAt: integer("started_at").notNull(),
    resolvedAt: integer("resolved_at"),
    resolution: text({ enum: ["recovered", "disabled", "deleted"] }),
    cause: text().notNull(),
    lastHttpStatus: integer("last_http_status"),
  },
  (table) => [
    check(
      "incidents_resolution",
      sql`${table.resolution} is null or ${table.resolution} in ('recovered', 'disabled', 'deleted')`
    ),
    uniqueIndex("incidents_one_open")
      .on(table.monitorId)
      .where(sql`${table.resolvedAt} is null`),
  ]
);

export const alertChannels = sqliteTable(
  "alert_channels",
  {
    id: text().primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id),
    kind: text({ enum: ["slack", "discord"] }).notNull(),
    webhookUrl: text("webhook_url").notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    check("alert_channels_kind", sql`${table.kind} in ('slack', 'discord')`),
    check("alert_channels_enabled", sql`${table.enabled} in (0, 1)`),
  ]
);

export const alertDeliveries = sqliteTable(
  "alert_deliveries",
  {
    incidentId: text("incident_id")
      .notNull()
      .references(() => incidents.id),
    eventKind: text("event_kind", { enum: ["down", "up"] }).notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => alertChannels.id),
    state: text({
      enum: ["pending", "delivering", "delivered", "failed"],
    }).notNull(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    leaseUntil: integer("lease_until"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.incidentId, table.eventKind, table.channelId],
    }),
    check(
      "alert_deliveries_event_kind",
      sql`${table.eventKind} in ('down', 'up')`
    ),
    check(
      "alert_deliveries_state",
      sql`${table.state} in ('pending', 'delivering', 'delivered', 'failed')`
    ),
    index("alert_deliveries_claimable")
      .on(table.state, table.leaseUntil)
      .where(sql`${table.state} in ('pending', 'delivering')`),
  ]
);

export const relations = defineRelations({
  alertChannels,
  alertDeliveries,
  incidents,
  monitors,
});
