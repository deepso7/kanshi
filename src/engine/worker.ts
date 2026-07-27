import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpServerResponse } from "effect/unstable/http";

import { Database } from "../db/client.ts";
import { runEngine } from "./engine.ts";

export default class EngineWorker extends Cloudflare.Worker<EngineWorker>()(
  "Engine",
  {
    main: import.meta.url,
  },
  Effect.gen(function* EngineWorkerInit() {
    const database = yield* Database;
    yield* Cloudflare.D1.QueryDatabase(database);

    const baseUrl = yield* Config.string("TINYBIRD_URL");
    const appendToken = yield* Config.redacted("TINYBIRD_APPEND_TOKEN");
    const readToken = yield* Config.redacted("TINYBIRD_READ_TOKEN");

    yield* Cloudflare.Workers.cron("* * * * *", () =>
      runEngine({
        appendToken: Redacted.value(appendToken),
        baseUrl,
        readToken: Redacted.value(readToken),
      })
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("kanshi engine")),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.Workers.CronEventSourceLive,
      FetchHttpClient.layer,
    ])
  )
) {}
