// Upgrades a populated Registry through its real migration list, run by
// the same client and migrator the Durable Object uses
// (`@effect/sql-sqlite-do`), over Node's built-in SQLite instead of the
// object's storage.
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as String from "effect/String";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { registryMigrationRecord } from "../../src/registry/migrations.ts";

type Storage = NonNullable<SqliteClient.SqliteClientConfig["storage"]>;

/**
 * The part of Durable Object storage the SQLite client uses: `sql.exec`
 * (a cursor with `columnNames` and `raw()`) and `transaction`, which
 * commits unless the closure throws or calls `rollback()`.
 */
interface ClientStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...params: SQLInputValue[]
    ) => {
      readonly columnNames: string[];
      readonly raw: () => Iterator<unknown>;
    };
  };
  readonly transaction: (
    closure: (txn: { readonly rollback: () => void }) => Promise<void>
  ) => Promise<void>;
}

const localStorage = (db: DatabaseSync): Storage => {
  const storage: ClientStorage = {
    sql: {
      exec: (query, ...params) => {
        const statement = db.prepare(query);
        statement.setReturnArrays(true);
        const columnNames = statement.columns().map((column) => column.name);
        const rows: readonly unknown[] =
          columnNames.length === 0
            ? (statement.run(...params), [])
            : statement.all(...params);
        return { columnNames, raw: () => rows.values() };
      },
    },
    transaction: async (closure) => {
      let rolledBack = false;
      db.exec("BEGIN");
      try {
        await closure({
          rollback: () => {
            rolledBack = true;
          },
        });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec(rolledBack ? "ROLLBACK" : "COMMIT");
    },
  };
  // SAFETY: the client only calls `sql.exec` (reading `columnNames` and
  // `raw()`) and `transaction(closure)` on the storage; this double
  // implements exactly those over a local SQLite database.
  return storage as Storage;
};

/** The client the Registry opens, over `db`. */
const clientLayer = (db: DatabaseSync) =>
  SqliteClient.layer({
    storage: localStorage(db),
    transformQueryNames: String.camelToSnake,
    transformResultNames: String.snakeToCamel,
  });

/** Run the Registry migrations with an id up to `through`. */
const migrate = (db: DatabaseSync, through: number) =>
  SqliteMigrator.run({
    loader: SqliteMigrator.fromRecord(
      Object.fromEntries(
        Object.entries(registryMigrationRecord).filter(
          ([key]) => Number(key.split("_", 1)[0]) <= through
        )
      )
    ),
  }).pipe(Effect.provide(clientLayer(db)));

const columns = (db: DatabaseSync, table: string): readonly string[] =>
  db
    .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all(table)
    .map((row) => `${row.name}`);

const rows = (db: DatabaseSync, query: string) =>
  db
    .prepare(query)
    .all()
    .map((row) => ({ ...row }));

describe("Registry migrations", () => {
  it.effect("upgrade a populated version 4 Registry, keeping its data", () =>
    Effect.gen(function* upgradeTest() {
      const db = new DatabaseSync(":memory:");
      const applied = yield* migrate(db, 4);
      assert.deepStrictEqual(
        applied.map(([id]) => id),
        [1, 2, 3, 4]
      );
      assert.includeMembers(
        [...columns(db, "monitors")],
        ["last_checked_at", "stale_runs", "stale_episode_id", "url"]
      );

      // A version 4 Registry in use: a stale monitor with an open episode
      // and its queued alert, a healthy one, a channel.
      db.exec(`INSERT INTO monitors (id, key, managed, lifecycle, op_id,
          public, name, status, enabled, last_checked_at, interval_seconds,
          summary_revision, created_at, updated_at, stale_runs,
          stale_episode_id, url)
        VALUES
          ('m1', 'site', 1, 'active', 'op1', 1, 'Site', 'up', 1, 1000, 60,
            3, 100, 1000, 2, 'watchdog-e1', 'https://example.com/'),
          ('m2', 'api', 0, 'creating', 'op2', 0, 'API', 'unknown', 0,
            NULL, 300, 0, 200, 200, 0, NULL, '')`);
      db.exec(`INSERT INTO channels (id, key, managed, kind, url, url_hash,
          name, created_at, updated_at)
        VALUES ('c1', 'ops', 0, 'webhook', 'https://hooks.example/x', 'h1',
          'Ops', 50, 60)`);
      db.exec(`INSERT INTO watchdog_episodes (id, monitor_id, monitor_name,
          monitor_url, interval_seconds, last_checked_at, started_at,
          resolved_at, resolution)
        VALUES
          ('watchdog-e1', 'm1', 'Site', 'https://example.com/', 60, 1000,
            5000, NULL, NULL),
          ('watchdog-e0', 'm1', 'Site', 'https://example.com/', 60, 400,
            900, 950, 'recovered')`);
      db.exec(`INSERT INTO watchdog_outbox (incident_id, event, channel_id,
          state, attempts, next_attempt_at, last_error, combined,
          created_at, updated_at)
        VALUES ('watchdog-e1', 'down', 'c1', 'pending', 1, 6000, 'timeout',
          0, 5000, 5500)`);
      const channelsBefore = rows(db, "SELECT * FROM channels");
      const episodesBefore = rows(
        db,
        "SELECT * FROM watchdog_episodes ORDER BY id"
      );
      const outboxBefore = rows(db, "SELECT * FROM watchdog_outbox");

      // The full list: 5 to 7 are pending.
      const upgraded = yield* migrate(db, Number.POSITIVE_INFINITY);
      assert.deepStrictEqual(
        upgraded.map(([id, name]) => `${id}_${name}`),
        [
          "5_summary_without_last_checked",
          "6_watchdog_single_observation",
          "7_drop_keys",
        ]
      );

      assert.deepStrictEqual(columns(db, "monitors"), [
        "id",
        "lifecycle",
        "op_id",
        "public",
        "name",
        "status",
        "enabled",
        "interval_seconds",
        "summary_revision",
        "created_at",
        "updated_at",
        "url",
        "stale_episode_id",
      ]);
      assert.deepStrictEqual(rows(db, "SELECT * FROM monitors ORDER BY id"), [
        {
          created_at: 100,
          enabled: 1,
          id: "m1",
          interval_seconds: 60,
          lifecycle: "active",
          name: "Site",
          op_id: "op1",
          public: 1,
          stale_episode_id: "watchdog-e1",
          status: "up",
          summary_revision: 3,
          updated_at: 1000,
          url: "https://example.com/",
        },
        {
          created_at: 200,
          enabled: 0,
          id: "m2",
          interval_seconds: 300,
          lifecycle: "creating",
          name: "API",
          op_id: "op2",
          public: 0,
          stale_episode_id: null,
          status: "unknown",
          summary_revision: 0,
          updated_at: 200,
          url: "",
        },
      ]);
      assert.deepStrictEqual(columns(db, "channels"), [
        "id",
        "kind",
        "url",
        "name",
        "created_at",
        "updated_at",
      ]);
      assert.deepStrictEqual(
        rows(db, "SELECT * FROM channels"),
        channelsBefore.map(
          ({ key: _key, managed: _managed, url_hash: _urlHash, ...rest }) =>
            rest
        )
      );
      assert.deepStrictEqual(
        rows(db, "SELECT * FROM watchdog_episodes ORDER BY id"),
        episodesBefore
      );
      assert.deepStrictEqual(
        rows(db, "SELECT * FROM watchdog_outbox"),
        outboxBefore
      );
      // Rows no longer need a key: two monitors may share a name.
      db.exec(`INSERT INTO monitors (id, lifecycle, op_id, public, name,
          status, enabled, interval_seconds, summary_revision, created_at,
          updated_at)
        VALUES ('m3', 'active', 'op3', 0, 'Site', 'up', 1, 60, 0, 300, 300)`);
      db.exec(`DELETE FROM monitors WHERE id = 'm3'`);

      // The Registry's own queries work on the upgraded schema.
      const listed = yield* Effect.gen(function* listEffect() {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          id: string;
          staleEpisodeId: string | null;
        }>`SELECT id, stale_episode_id FROM monitors ORDER BY created_at, id`;
      }).pipe(Effect.provide(clientLayer(db)));
      assert.deepStrictEqual(
        listed.map((row) => [row.id, row.staleEpisodeId]),
        [
          ["m1", "watchdog-e1"],
          ["m2", null],
        ]
      );

      // Applied migrations are skipped on the next activation.
      assert.deepStrictEqual(yield* migrate(db, Number.POSITIVE_INFINITY), []);
      db.close();
    })
  );
});
