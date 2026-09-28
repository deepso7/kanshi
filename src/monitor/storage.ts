import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ChannelSelection,
  CheckErrorKind,
  CheckKind,
  IncidentResolution,
  Inflight,
  LastResult,
  MonitorConfig,
  MonitorState,
} from "../domain/monitor.ts";
import type { CheckRecord, IncidentClose, IncidentOpen } from "./cycle.ts";

/**
 * Monitor DO schema. Column names are snake_case; the SQL client maps them
 * to and from camelCase. Add a new numbered entry for every schema change
 * (never edit an applied one): migrations run once per object, on its next
 * activation.
 */
export const migrations = SqliteMigrator.fromRecord({
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
});

/** Tables wiped by `destroy()`; the tombstone is kept. */
const dataTables = ["config", "state", "checks", "incidents"] as const;

const ConfigRow = Schema.Struct({
  ...MonitorConfig.fields,
  channels: Schema.fromJsonString(ChannelSelection),
  enabled: Schema.BooleanFromBit,
  managed: Schema.BooleanFromBit,
});

const StateRow = Schema.Struct({
  ...MonitorState.fields,
  confirmCounted: Schema.BooleanFromBit,
  inflight: Schema.NullOr(Schema.fromJsonString(Inflight)),
  lastResult: Schema.NullOr(Schema.fromJsonString(LastResult)),
});

export const CheckRow = Schema.Struct({
  at: Schema.Number,
  checkId: Schema.String,
  counted: Schema.BooleanFromBit,
  errorKind: Schema.NullOr(CheckErrorKind),
  kind: CheckKind,
  latencyMs: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
  ok: Schema.BooleanFromBit,
  status: Schema.NullOr(Schema.Number),
});
export type CheckRow = typeof CheckRow.Type;

export const IncidentRow = Schema.Struct({
  cause: Schema.String,
  id: Schema.String,
  lastHttpStatus: Schema.NullOr(Schema.Number),
  resolution: Schema.NullOr(IncidentResolution),
  resolvedAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.Number,
});
export type IncidentRow = typeof IncidentRow.Type;

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
    yield* sql`INSERT OR IGNORE INTO incidents ${sql.insert({
      cause: incident.cause,
      id: incident.id,
      lastHttpStatus: incident.lastHttpStatus,
      startedAt: incident.startedAt,
    })}`;
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

export const recentChecks = Effect.fn("MonitorStorage.recentChecks")(
  function* recentChecksEffect(limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT * FROM checks ORDER BY at DESC, check_id DESC LIMIT ${limit}`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(CheckRow))(rows).pipe(
      Effect.orDie
    );
  }
);

export const listIncidents = Effect.fn("MonitorStorage.listIncidents")(
  function* listIncidentsEffect(limit: number) {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT * FROM incidents ORDER BY started_at DESC LIMIT ${limit}`;
    return yield* Schema.decodeUnknownEffect(Schema.Array(IncidentRow))(
      rows
    ).pipe(Effect.orDie);
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
