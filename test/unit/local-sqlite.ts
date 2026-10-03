// A local SQLite (Node's built-in) behind the same client and migrator a
// Durable Object uses (`@effect/sql-sqlite-do`), to run the real migration
// lists against populated tables.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import * as String from "effect/String";

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

/** The client a Durable Object opens, over `db`. */
export const clientLayer = (db: DatabaseSync) =>
  SqliteClient.layer({
    storage: localStorage(db),
    transformQueryNames: String.camelToSnake,
    transformResultNames: String.snakeToCamel,
  });

/** Run the migrations in `record` with an id up to `through`. */
export const migrate = (
  db: DatabaseSync,
  record: Record<string, Effect.Effect<unknown, unknown, SqlClient.SqlClient>>,
  through: number
) =>
  SqliteMigrator.run({
    loader: SqliteMigrator.fromRecord(
      Object.fromEntries(
        Object.entries(record).filter(
          ([key]) => Number(key.split("_", 1)[0]) <= through
        )
      )
    ),
  }).pipe(Effect.provide(clientLayer(db)));

export const columns = (db: DatabaseSync, table: string): readonly string[] =>
  db
    .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all(table)
    .map((row) => `${row.name}`);

export const rows = (db: DatabaseSync, query: string) =>
  db
    .prepare(query)
    .all()
    .map((row) => ({ ...row }));
