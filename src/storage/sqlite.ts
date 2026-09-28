import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as String from "effect/String";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Open the Effect SQL client over a Durable Object's SQLite storage and run
 * its migrations. Call it from the DO's instance effect (it runs on every
 * activation; applied migrations are skipped). Columns are snake_case in
 * SQL and camelCase in rows and `sql.insert` records.
 */
export const openDurableSql = Effect.fn("Storage.openDurableSql")(
  function* openDurableSqlEffect(
    state: Cloudflare.DurableObjectState["Service"],
    migrations: SqliteMigrator.Loader
  ) {
    const context = yield* Layer.build(
      SqliteClient.layer({
        storage: state.raw.storage,
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      })
    );
    yield* SqliteMigrator.run({ loader: migrations }).pipe(
      Effect.provideContext(context),
      // The object is unusable without its schema.
      Effect.orDie
    );
    return Context.get(context, SqlClient.SqlClient);
  }
);
