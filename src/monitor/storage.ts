import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AlertEvent } from "../domain/alert.ts";
import { Notification, OutboxEntry } from "../domain/alert.ts";
import type { DailyRollup } from "../domain/history.ts";
import { Check, Incident } from "../domain/history.ts";
import type { IncidentResolution, ResponseExcerpt } from "../domain/monitor.ts";
import {
  ChannelSelection,
  Inflight,
  LastResult,
  MonitorConfig,
  MonitorState,
} from "../domain/monitor.ts";
import type { CheckRecord, IncidentClose, IncidentOpen } from "./cycle.ts";
import type { EnabledPeriod, PeriodChange, Sample } from "./history.ts";

/**
 * Monitor DO schema. Column names are snake_case; the SQL client maps them
 * to and from camelCase. Add a new numbered entry for every schema change
 * (never edit an applied one): migrations run once per object, on its next
 * activation. Tests run them against a local SQLite
 * (`test/unit/monitor-migrations.test.ts`).
 */
export const monitorMigrationRecord = {
  "1_core": Effect.gen(function* coreMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL,
      key TEXT NOT NULL,
      managed INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL,
      expected_status TEXT NOT NULL,
      body_contains TEXT,
      timeout_ms INTEGER NOT NULL,
      interval_seconds INTEGER NOT NULL,
      failure_threshold INTEGER NOT NULL,
      success_threshold INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      channels TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL,
      failure_streak INTEGER NOT NULL,
      success_streak INTEGER NOT NULL,
      last_checked_at INTEGER,
      last_result TEXT,
      open_incident_id TEXT,
      next_check_at INTEGER NOT NULL,
      next_check_kind TEXT NOT NULL,
      next_slot_at INTEGER NOT NULL,
      confirm_counted INTEGER NOT NULL,
      manual_requested_at INTEGER,
      inflight TEXT,
      summary_revision INTEGER NOT NULL,
      next_maintenance_at INTEGER,
      rolled_up_through TEXT
    )`;
    yield* sql`CREATE TABLE tombstone (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      deleted_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE checks (
      check_id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      counted INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      status INTEGER,
      latency_ms INTEGER,
      error_kind TEXT,
      message TEXT
    )`;
    yield* sql`CREATE INDEX checks_at ON checks (at)`;
    yield* sql`CREATE TABLE incidents (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT,
      cause TEXT NOT NULL,
      last_http_status INTEGER
    )`;
  }),
  "2_alerts": Effect.gen(function* alertsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE notifications (
      incident_id TEXT NOT NULL,
      event TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      resolved INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      PRIMARY KEY (incident_id, event)
    )`;
    yield* sql`CREATE INDEX notifications_resolved ON notifications (resolved)`;
    yield* sql`CREATE TABLE incident_recipients (
      incident_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (incident_id, channel_id)
    )`;
    yield* sql`CREATE TABLE outbox (
      incident_id TEXT NOT NULL,
      event TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      combined INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (incident_id, event, channel_id)
    )`;
    yield* sql`CREATE INDEX outbox_state ON outbox (state)`;
  }),
  "3_history": Effect.gen(function* historyMigration() {
    const sql = yield* SqlClient.SqlClient;
    // Spans during which the monitor was enabled, one per interval in
    // force; `expected` samples per day are derived from them.
    yield* sql`CREATE TABLE enabled_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      interval_seconds INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE daily_rollups (
      day TEXT PRIMARY KEY,
      counted INTEGER NOT NULL,
      up INTEGER NOT NULL,
      down INTEGER NOT NULL,
      expected REAL NOT NULL,
      p50 INTEGER,
      p95 INTEGER
    )`;
    yield* sql`CREATE INDEX incidents_resolved_at ON incidents (resolved_at)`;
    // Existing monitors: assume enabled since creation, maintain now.
    yield* sql`INSERT INTO enabled_periods (started_at, ended_at, interval_seconds)
      SELECT created_at, NULL, interval_seconds FROM config WHERE enabled = 1`;
    yield* sql`UPDATE state SET next_maintenance_at = ${Date.now()}
      WHERE next_maintenance_at IS NULL`;
  }),
  "4_schedule_reset": Effect.gen(function* scheduleResetMigration() {
    const sql = yield* SqlClient.SqlClient;
    // When the check schedule last restarted. Existing monitors: the last
    // edit is the best (conservative) estimate.
    yield* sql`ALTER TABLE state
      ADD COLUMN schedule_reset_at INTEGER NOT NULL DEFAULT 0`;
    yield* sql`UPDATE state SET schedule_reset_at = coalesce(
      (SELECT updated_at FROM config WHERE singleton = 1), 0)`;
  }),
  // Config sync is gone: monitors no longer have a key or a managed flag.
  "5_drop_key_managed": Effect.gen(function* dropKeyManagedMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE config DROP COLUMN key`;
    yield* sql`ALTER TABLE config DROP COLUMN managed`;
  }),
  // What the opening check saw, for the incident's alerts: its latency and
  // the start of the response body (not kept per check). Existing
  // incidents have neither.
  "6_incident_excerpt": Effect.gen(function* incidentExcerptMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE incidents ADD COLUMN latency_ms INTEGER`;
    yield* sql`ALTER TABLE incidents ADD COLUMN response_excerpt TEXT`;
    yield* sql`ALTER TABLE incidents
      ADD COLUMN response_truncated INTEGER NOT NULL DEFAULT 0`;
  }),
} satisfies Record<
  string,
  Effect.Effect<unknown, unknown, SqlClient.SqlClient>
>;

export const migrations = SqliteMigrator.fromRecord(monitorMigrationRecord);

/** Tables wiped by `destroy()`; the tombstone is kept. */
const dataTables = [
  "config",
  "state",
  "checks",
  "incidents",
  "notifications",
  "incident_recipients",
  "outbox",
  "enabled_periods",
  "daily_rollups",
] as const;

const ConfigRow = Schema.Struct({
  ...MonitorConfig.fields,
  channels: Schema.fromJsonString(ChannelSelection),
  enabled: Schema.BooleanFromBit,
});

const StateRow = Schema.Struct({
  ...MonitorState.fields,
  confirmCounted: Schema.BooleanFromBit,
  inflight: Schema.NullOr(Schema.fromJsonString(Inflight)),
  lastResult: Schema.NullOr(Schema.fromJsonString(LastResult)),
});

export const CheckRow = Schema.Struct({
  ...Check.fields,
  counted: Schema.BooleanFromBit,
  ok: Schema.BooleanFromBit,
});
export type CheckRow = typeof CheckRow.Type;

/**
 * A stored incident: the API's {@link Incident} plus what its opening
 * check saw, which only its alerts use.
 */
export const IncidentRow = Schema.Struct({
  ...Incident.fields,
  latencyMs: Schema.NullOr(Schema.Number),
  responseExcerpt: Schema.NullOr(Schema.String),
  responseTruncated: Schema.BooleanFromBit,
});
export type IncidentRow = typeof IncidentRow.Type;

/** The opening check's response excerpt of a stored incident. */
export const incidentExcerpt = (
  row: Pick<IncidentRow, "responseExcerpt" | "responseTruncated">
): ResponseExcerpt | null =>
  row.responseExcerpt === null
    ? null
    : { text: row.responseExcerpt, truncated: row.responseTruncated };

const NotificationRow = Schema.Struct({
  ...Notification.fields,
  resolved: Schema.BooleanFromBit,
});

const OutboxRow = Schema.Struct({
  ...OutboxEntry.fields,
  combined: Schema.BooleanFromBit,
});

const decodeNotifications = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(NotificationRow))(rows).pipe(
    Effect.orDie
  );

const decodeOutbox = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(OutboxRow))(rows).pipe(Effect.orDie);

const decodeOne =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (rows: readonly unknown[]) =>
    rows.length === 0
      ? Effect.succeed(null)
      : Schema.decodeUnknownEffect(schema)(rows[0]).pipe(Effect.orDie);

/**
 * Typed access to one Monitor DO's tables. Every function needs the DO's
 * `SqlClient`; callers group writes with `sql.withTransaction`.
 */
export const readConfig = Effect.gen(function* readConfigEffect() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT * FROM config WHERE singleton = 1`;
  return yield* decodeOne(ConfigRow)(rows);
});

export const readState = Effect.gen(function* readStateEffect() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT * FROM state WHERE singleton = 1`;
  return yield* decodeOne(StateRow)(rows);
});

export const readTombstone = Effect.gen(function* readTombstoneEffect() {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    deletedAt: number;
  }>`SELECT deleted_at FROM tombstone WHERE singleton = 1`;
  return rows[0]?.deletedAt ?? null;
});

export const writeConfig = Effect.fn("MonitorStorage.writeConfig")(
  function* writeConfigEffect(config: MonitorConfig) {
    const sql = yield* SqlClient.SqlClient;
    const row = Schema.encodeSync(ConfigRow)(config);
    yield* sql`INSERT OR REPLACE INTO config ${sql.insert({ singleton: 1, ...row })}`;
  }
);

export const writeState = Effect.fn("MonitorStorage.writeState")(
  function* writeStateEffect(state: MonitorState) {
    const sql = yield* SqlClient.SqlClient;
    const row = Schema.encodeSync(StateRow)(state);
    yield* sql`INSERT OR REPLACE INTO state ${sql.insert({ singleton: 1, ...row })}`;
  }
);

export const insertCheck = Effect.fn("MonitorStorage.insertCheck")(
  function* insertCheckEffect(check: CheckRecord) {
    const sql = yield* SqlClient.SqlClient;
    const row = Schema.encodeSync(CheckRow)(check);
    yield* sql`INSERT OR IGNORE INTO checks ${sql.insert(row)}`;
  }
);

export const openIncident = Effect.fn("MonitorStorage.openIncident")(
  function* openIncidentEffect(incident: IncidentOpen) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO incidents ${sql.insert(
      Schema.encodeSync(IncidentRow)({
        cause: incident.cause,
        id: incident.id,
        lastHttpStatus: incident.lastHttpStatus,
        latencyMs: incident.latencyMs,
        resolution: null,
        resolvedAt: null,
        responseExcerpt: incident.responseExcerpt?.text ?? null,
        responseTruncated: incident.responseExcerpt?.truncated ?? false,
        startedAt: incident.startedAt,
      })
    )}`;
  }
);

export const closeIncident = Effect.fn("MonitorStorage.closeIncident")(
  function* closeIncidentEffect(
    incident: IncidentClose,
    resolution: IncidentResolution
  ) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE incidents
      SET resolved_at = ${incident.resolvedAt}, resolution = ${resolution}
      WHERE id = ${incident.id} AND resolved_at IS NULL`;
  }
);

/** Checks at or after `since`, newest first. */
export const recentChecks = Effect.fn("MonitorStorage.recentChecks")(
  function* recentChecksEffect(options: {
    readonly limit: number;
    readonly since?: number | undefined;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT * FROM checks
      WHERE at >= ${options.since ?? 0}
      ORDER BY at DESC, check_id DESC LIMIT ${options.limit}`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(CheckRow))(rows).pipe(
      Effect.orDie
    );
  }
);

/**
 * Counted samples since `since`, and per-bucket (`bucketMs` wide, from
 * `since`) mean latency of successful counted checks and counted failures.
 * Manual (uncounted) checks are left out of both.
 */
export const readRecent = Effect.fn("MonitorStorage.readRecent")(
  function* readRecentEffect(since: number, bucketMs: number) {
    const sql = yield* SqlClient.SqlClient;
    const [totals] = yield* sql<{
      counted: number;
      up: number | null;
    }>`SELECT count(*) AS counted, sum(ok) AS up FROM checks
      WHERE counted = 1 AND at >= ${since}`;
    const buckets = yield* sql<{
      bucket: number;
      failures: number | null;
      latencyMs: number | null;
    }>`SELECT CAST((at - ${since}) / ${bucketMs} AS INTEGER) AS bucket,
        avg(CASE WHEN ok = 1 THEN latency_ms END) AS latency_ms,
        sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
      FROM checks
      WHERE counted = 1 AND at >= ${since}
      GROUP BY bucket
      ORDER BY bucket`;
    return {
      buckets,
      counted: totals?.counted ?? 0,
      up: totals?.up ?? 0,
    };
  }
);

/** Incidents as the API shows them, without the alert-only columns. */
export const listIncidents = Effect.fn("MonitorStorage.listIncidents")(
  function* listIncidentsEffect(limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT id, started_at, resolved_at, resolution,
        cause, last_http_status
      FROM incidents ORDER BY started_at DESC LIMIT ${limit}`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(Incident))(rows).pipe(
      Effect.orDie
    );
  }
);

export const readIncident = Effect.fn("MonitorStorage.readIncident")(
  function* readIncidentEffect(id: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT * FROM incidents WHERE id = ${id}`;
    return yield* decodeOne(IncidentRow)(rows);
  }
);

/** The durable intent to alert; written with the transition. */
export const insertNotification = Effect.fn(
  "MonitorStorage.insertNotification"
)(function* insertNotificationEffect(
  incidentId: string,
  event: AlertEvent,
  now: number
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO notifications ${sql.insert(
    Schema.encodeSync(NotificationRow)({
      attempts: 0,
      createdAt: now,
      event,
      incidentId,
      lastError: null,
      nextAttemptAt: now,
      resolved: false,
    })
  )}`;
});

/**
 * Pending alert work: every notification of an incident that has an
 * unresolved one, and every outbox row of an incident that has a pending
 * one (so each pending `up` row comes with its `down` row).
 */
export const readAlertWork = Effect.gen(function* readAlertWorkEffect() {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* sql`SELECT * FROM notifications
    WHERE incident_id IN (
      SELECT incident_id FROM notifications WHERE resolved = 0
    )`.pipe(Effect.flatMap(decodeNotifications));
  const outbox = yield* sql`SELECT * FROM outbox
    WHERE incident_id IN (
      SELECT incident_id FROM outbox WHERE state = 'pending'
    )`.pipe(Effect.flatMap(decodeOutbox));
  return { notifications, outbox };
});

export const writeNotification = Effect.fn("MonitorStorage.writeNotification")(
  function* writeNotificationEffect(notification: Notification) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE notifications
      SET attempts = ${notification.attempts},
          next_attempt_at = ${notification.nextAttemptAt},
          last_error = ${notification.lastError},
          resolved = ${notification.resolved ? 1 : 0}
      WHERE incident_id = ${notification.incidentId}
        AND event = ${notification.event}`;
  }
);

const pendingOutboxRow = (
  incidentId: string,
  event: AlertEvent,
  channelId: string,
  now: number
) =>
  Schema.encodeSync(OutboxRow)({
    attempts: 0,
    channelId,
    combined: false,
    createdAt: now,
    event,
    incidentId,
    lastError: null,
    nextAttemptAt: now,
    state: "pending",
    updatedAt: now,
  });

/**
 * Resolve a `down` notification: fix the incident's recipients and queue a
 * `down` alert for each. Idempotent; run in one transaction.
 */
export const resolveDown = Effect.fn("MonitorStorage.resolveDown")(
  function* resolveDownEffect(
    incidentId: string,
    channelIds: readonly string[],
    now: number
  ) {
    const sql = yield* SqlClient.SqlClient;
    for (const channelId of channelIds) {
      yield* sql`INSERT OR IGNORE INTO incident_recipients ${sql.insert({
        channelId,
        incidentId,
      })}`;
      yield* sql`INSERT OR IGNORE INTO outbox ${sql.insert(
        pendingOutboxRow(incidentId, "down", channelId, now)
      )}`;
    }
    yield* sql`UPDATE notifications SET resolved = 1, last_error = NULL
      WHERE incident_id = ${incidentId} AND event = 'down'`;
  }
);

/**
 * Resolve an `up` notification: queue an `up` alert for every recipient of
 * the incident's `down`. Idempotent; run in one transaction.
 */
export const resolveUp = Effect.fn("MonitorStorage.resolveUp")(
  function* resolveUpEffect(incidentId: string, now: number) {
    const sql = yield* SqlClient.SqlClient;
    const recipients = yield* sql<{
      channelId: string;
    }>`SELECT channel_id FROM incident_recipients WHERE incident_id = ${incidentId}`;
    for (const { channelId } of recipients) {
      yield* sql`INSERT OR IGNORE INTO outbox ${sql.insert(
        pendingOutboxRow(incidentId, "up", channelId, now)
      )}`;
    }
    yield* sql`UPDATE notifications SET resolved = 1, last_error = NULL
      WHERE incident_id = ${incidentId} AND event = 'up'`;
  }
);

/** An outbox row and, for an `up` row, its `down` row. */
export const readOutboxPair = Effect.fn("MonitorStorage.readOutboxPair")(
  function* readOutboxPairEffect(
    incidentId: string,
    event: AlertEvent,
    channelId: string
  ) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT * FROM outbox
      WHERE incident_id = ${incidentId} AND channel_id = ${channelId}`.pipe(
      Effect.flatMap(decodeOutbox)
    );
    return {
      down: rows.find((row) => row.event === "down") ?? null,
      entry: rows.find((row) => row.event === event) ?? null,
    };
  }
);

/** Store an attempt's outcome; only a still-pending row is updated. */
export const writeOutbox = Effect.fn("MonitorStorage.writeOutbox")(
  function* writeOutboxEffect(entry: OutboxEntry) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE outbox
      SET state = ${entry.state},
          attempts = ${entry.attempts},
          next_attempt_at = ${entry.nextAttemptAt},
          last_error = ${entry.lastError},
          combined = ${entry.combined ? 1 : 0},
          updated_at = ${entry.updatedAt}
      WHERE incident_id = ${entry.incidentId}
        AND event = ${entry.event}
        AND channel_id = ${entry.channelId}
        AND state = 'pending'`;
  }
);

/** Recent alert rows, for the dev inspector. */
export const recentAlerts = Effect.fn("MonitorStorage.recentAlerts")(
  function* recentAlertsEffect(limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const notifications = yield* sql`SELECT * FROM notifications
      ORDER BY created_at DESC, event DESC LIMIT ${limit}`.pipe(
      Effect.flatMap(decodeNotifications)
    );
    const outbox = yield* sql`SELECT * FROM outbox
      ORDER BY created_at DESC, event DESC, channel_id LIMIT ${limit}`.pipe(
      Effect.flatMap(decodeOutbox)
    );
    const recipients = yield* sql<{
      channelId: string;
      incidentId: string;
    }>`SELECT * FROM incident_recipients ORDER BY incident_id, channel_id LIMIT ${limit}`;
    return { notifications, outbox, recipients };
  }
);

/** Apply a config change to the enabled-periods log. */
export const recordPeriodChange = Effect.fn(
  "MonitorStorage.recordPeriodChange"
)(function* recordPeriodChangeEffect(change: PeriodChange, now: number) {
  const sql = yield* SqlClient.SqlClient;
  if (change.close) {
    yield* sql`UPDATE enabled_periods SET ended_at = ${now}
        WHERE ended_at IS NULL`;
  }
  if (change.open !== null) {
    yield* sql`INSERT INTO enabled_periods ${sql.insert({
      endedAt: null,
      intervalSeconds: change.open.intervalSeconds,
      startedAt: now,
    })}`;
  }
});

/** Enabled periods overlapping `[from, to)`. */
export const readPeriods = Effect.fn("MonitorStorage.readPeriods")(
  function* readPeriodsEffect(from: number, to: number) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<EnabledPeriod>`SELECT started_at, ended_at, interval_seconds
      FROM enabled_periods
      WHERE started_at < ${to} AND (ended_at IS NULL OR ended_at > ${from})
      ORDER BY started_at`;
  }
);

/** Counted samples in `[from, to)`. */
export const readSamples = Effect.fn("MonitorStorage.readSamples")(
  function* readSamplesEffect(from: number, to: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      latencyMs: number | null;
      ok: number;
    }>`SELECT ok, latency_ms FROM checks
      WHERE counted = 1 AND at >= ${from} AND at < ${to}`;
    return rows.map((row): Sample => ({
      latencyMs: row.latencyMs,
      ok: row.ok === 1,
    }));
  }
);

export const writeRollup = Effect.fn("MonitorStorage.writeRollup")(
  function* writeRollupEffect(rollup: DailyRollup) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR REPLACE INTO daily_rollups ${sql.insert({ ...rollup })}`;
  }
);

/** Rollups for days in `[fromDay, toDay]`, oldest first. */
export const readRollups = Effect.fn("MonitorStorage.readRollups")(
  function* readRollupsEffect(fromDay: string, toDay: string) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<DailyRollup>`SELECT * FROM daily_rollups
      WHERE day >= ${fromDay} AND day <= ${toDay} ORDER BY day`;
  }
);

export interface PruneCounts {
  readonly checks: number;
  readonly incidents: number;
  readonly periods: number;
}

/**
 * Retention: raw checks before `checksBefore`, enabled periods that ended
 * before `periodsBefore` (only rolled-up days need them), and incidents
 * resolved before `incidentsBefore` with no alert work pending, together
 * with their notifications, recipients and outbox rows.
 */
export const prune = Effect.fn("MonitorStorage.prune")(function* pruneEffect(
  checksBefore: number | null,
  periodsBefore: number | null,
  incidentsBefore: number
) {
  const sql = yield* SqlClient.SqlClient;
  const count = (table: string) =>
    sql<{ n: number }>`SELECT count(*) AS n FROM ${sql(table)}`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0)
    );
  const checksBeforeCount = yield* count("checks");
  if (checksBefore !== null) {
    yield* sql`DELETE FROM checks WHERE at < ${checksBefore}`;
  }
  const periodsBeforeCount = yield* count("enabled_periods");
  if (periodsBefore !== null) {
    yield* sql`DELETE FROM enabled_periods
      WHERE ended_at IS NOT NULL AND ended_at <= ${periodsBefore}`;
  }
  const incidentsBeforeCount = yield* count("incidents");
  yield* sql`DELETE FROM incidents
    WHERE resolved_at IS NOT NULL AND resolved_at < ${incidentsBefore}
      AND id NOT IN (SELECT incident_id FROM notifications WHERE resolved = 0)
      AND id NOT IN (SELECT incident_id FROM outbox WHERE state = 'pending')`;
  // Alert rows live and die with their incident.
  for (const table of ["notifications", "incident_recipients", "outbox"]) {
    yield* sql`DELETE FROM ${sql(table)}
      WHERE incident_id NOT IN (SELECT id FROM incidents)`;
  }
  return {
    checks: checksBeforeCount - (yield* count("checks")),
    incidents: incidentsBeforeCount - (yield* count("incidents")),
    periods: periodsBeforeCount - (yield* count("enabled_periods")),
  } satisfies PruneCounts;
});

/** Alert rows of the listed incidents, for the incidents endpoint. */
export const incidentAlerts = Effect.fn("MonitorStorage.incidentAlerts")(
  function* incidentAlertsEffect(incidentIds: readonly string[]) {
    const sql = yield* SqlClient.SqlClient;
    if (incidentIds.length === 0) {
      return [];
    }
    return yield* sql`SELECT * FROM outbox
      WHERE ${sql.in("incident_id", incidentIds)}
      ORDER BY created_at, event DESC, channel_id`.pipe(
      Effect.flatMap(decodeOutbox)
    );
  }
);

/**
 * Delete every row and leave the tombstone. Rows are deleted rather than
 * tables dropped so later migrations still apply to tombstoned objects.
 */
export const wipe = Effect.fn("MonitorStorage.wipe")(function* wipeEffect(
  deletedAt: number
) {
  const sql = yield* SqlClient.SqlClient;
  for (const table of dataTables) {
    yield* sql`DELETE FROM ${sql(table)}`;
  }
  yield* sql`INSERT OR IGNORE INTO tombstone ${sql.insert({ deletedAt, singleton: 1 })}`;
});
