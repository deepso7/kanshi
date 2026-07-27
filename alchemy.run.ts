import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import ApiWorker from "./src/api/worker.ts";
import { Database } from "./src/db/client.ts";
import EngineWorker from "./src/engine/worker.ts";

export default Alchemy.Stack(
  "Kanshi",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* KanshiStack() {
    const database = yield* Database;
    const api = yield* ApiWorker;
    const engine = yield* EngineWorker;

    return {
      apiUrl: api.url,
      databaseName: database.databaseName,
      engineUrl: engine.url,
    };
  })
);
