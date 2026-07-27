import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { relations } from "./schema.ts";

export const Database = Cloudflare.D1.Database("kanshi-db");

export const makeDatabaseClient = Effect.gen(
  function* DatabaseClientResource() {
    const database = yield* Database;
    const d1 = yield* Cloudflare.D1.QueryDatabase(database);
    const db = yield* Drizzle.D1(d1, { relations });

    return { d1, db };
  }
);

export class DatabaseClient extends Context.Service<
  DatabaseClient,
  Effect.Success<typeof makeDatabaseClient>
>()("kanshi/db/DatabaseClient") {}
