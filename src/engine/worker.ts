import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpServerResponse } from "effect/unstable/http";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { DatabaseClient, makeDatabaseClient } from "../db/client.ts";
import { runEngine } from "./engine.ts";

export default class EngineWorker extends Cloudflare.Worker<EngineWorker>()(
  "Engine",
  {
    main: import.meta.url,
  },
  Effect.gen(function* EngineWorkerInit() {
    const databaseClient = yield* makeDatabaseClient;

    const baseUrl = yield* Config.string("TINYBIRD_URL");
    const appendToken = yield* Config.redacted("TINYBIRD_APPEND_TOKEN");
    const readToken = yield* Config.redacted("TINYBIRD_READ_TOKEN");
    const apiToken = yield* Config.redacted("KANSHI_API_TOKEN");
    const tinybird = {
      appendToken: Redacted.value(appendToken),
      baseUrl,
      readToken: Redacted.value(readToken),
    };
    const run = () =>
      runEngine(tinybird).pipe(
        Effect.provideService(DatabaseClient, databaseClient)
      );

    yield* Cloudflare.Workers.cron("* * * * *", run);

    return {
      // Local alchemy does not fire Cron Triggers; POST /tick runs one pass.
      fetch: Effect.gen(function* EngineFetch() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://engine.local").pathname;
        if (request.method === "POST" && path === "/tick") {
          const expected = Redacted.value(apiToken);
          const header = request.headers.authorization ?? "";
          const token = header.toLowerCase().startsWith("bearer ")
            ? header.slice("bearer ".length)
            : "";
          if (token !== expected) {
            return HttpServerResponse.text("unauthorized", { status: 401 });
          }
          yield* run().pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Engine tick failed").pipe(
                Effect.annotateLogs({ cause: String(cause) })
              )
            )
          );
          return HttpServerResponse.text("ok");
        }
        return HttpServerResponse.text("kanshi engine");
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.Workers.CronEventSourceLive,
      FetchHttpClient.layer,
    ])
  )
) {}
