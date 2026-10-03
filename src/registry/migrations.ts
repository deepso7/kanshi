import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { watchdogMigration } from "./watchdog-store.ts";

/**
 * The Registry's schema, one entry per migration (`<id>_<name>`), applied
 * in id order on every activation. Never edit an applied migration; add a
 * new one. Kept apart from the Durable Object so tests can run it against
 * a local SQLite (`test/unit/registry-migrations.test.ts`).
 */
export const registryMigrationRecord = {
  "1_core": Effect.gen(function* coreMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE monitors (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      managed INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      op_id TEXT NOT NULL,
      public INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      last_checked_at INTEGER,
      interval_seconds INTEGER NOT NULL,
      summary_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // Dev stage only: webhook sink events and flip targets.
    yield* sql`CREATE TABLE dev_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE dev_flips (
      name TEXT PRIMARY KEY,
      up INTEGER NOT NULL
    )`;
  }),
  "2_channels": Effect.gen(function* channelsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      managed INTEGER NOT NULL,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // Dev stage only: counters for the webhook sink's `failTimes`.
    yield* sql`CREATE TABLE dev_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`;
  }),
  "3_watchdog": watchdogMigration,
  // The summary gains the target URL. Revision 0 lets the next summary
  // push (a check, an edit or the watchdog's refresh) fill it in.
  "4_monitor_url": Effect.gen(function* monitorUrlMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE monitors ADD COLUMN url TEXT NOT NULL DEFAULT ''`;
    yield* sql`UPDATE monitors SET summary_revision = 0`;
  }),
  // Monitors push their summary only when a Registry-visible field
  // changes, not after every check, so the summary no longer carries the
  // last check time (the dashboard reads it live from each monitor).
  "5_summary_without_last_checked": Effect.gen(
    function* summaryWithoutLastCheckedMigration() {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE monitors DROP COLUMN last_checked_at`;
    }
  ),
  // The hourly watchdog opens an episode on one stale observation, so the
  // consecutive-stale-runs counter is gone (`stale_episode_id` stays).
  "6_watchdog_single_observation": Effect.gen(
    function* watchdogSingleObservationMigration() {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE monitors DROP COLUMN stale_runs`;
    }
  ),
  // Config sync is gone: monitors and channels lose their key and managed
  // flag, channels their URL hash. `key` is UNIQUE, which SQLite cannot
  // drop in place, so both tables are rebuilt.
  "7_drop_keys": Effect.gen(function* dropKeysMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE monitors_new (
      id TEXT PRIMARY KEY,
      lifecycle TEXT NOT NULL,
      op_id TEXT NOT NULL,
      public INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      interval_seconds INTEGER NOT NULL,
      summary_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      stale_episode_id TEXT
    )`;
    yield* sql`INSERT INTO monitors_new
      SELECT id, lifecycle, op_id, public, name, status, enabled,
        interval_seconds, summary_revision, created_at, updated_at, url,
        stale_episode_id
      FROM monitors`;
    yield* sql`DROP TABLE monitors`;
    yield* sql`ALTER TABLE monitors_new RENAME TO monitors`;
    yield* sql`CREATE TABLE channels_new (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    yield* sql`INSERT INTO channels_new
      SELECT id, kind, url, name, created_at, updated_at FROM channels`;
    yield* sql`DROP TABLE channels`;
    yield* sql`ALTER TABLE channels_new RENAME TO channels`;
  }),
} satisfies Record<
  string,
  Effect.Effect<unknown, unknown, SqlClient.SqlClient>
>;

export const registryMigrations = SqliteMigrator.fromRecord(
  registryMigrationRecord
);
