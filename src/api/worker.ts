import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { DatabaseClient, makeDatabaseClient } from "../db/client.ts";
import { ApiAuthLive, bearerTokenValidatorLayer } from "./auth.ts";
import { MonitorsApiLive } from "./handlers.ts";
import { KanshiApi } from "./spec.ts";
import { StatusApiLive } from "./status.ts";

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export default class ApiWorker extends Cloudflare.Worker<ApiWorker>()(
  "Api",
  {
    main: import.meta.url,
  },
  Effect.gen(function* ApiWorkerInit() {
    const databaseClient = yield* makeDatabaseClient;
    const apiToken = yield* Config.redacted("KANSHI_API_TOKEN");
    if (Redacted.value(apiToken).trim().length === 0) {
      return yield* Effect.die(new Error("KANSHI_API_TOKEN must not be empty"));
    }
    const tinybirdUrl = yield* Config.string("TINYBIRD_URL");
    const tinybirdReadToken = yield* Config.redacted("TINYBIRD_READ_TOKEN");

    const app = HttpApiBuilder.layer(KanshiApi).pipe(
      Layer.provide([
        MonitorsApiLive,
        StatusApiLive({
          baseUrl: tinybirdUrl,
          readToken: Redacted.value(tinybirdReadToken),
        }),
      ]),
      Layer.provide(ApiAuthLive),
      Layer.provide(bearerTokenValidatorLayer(apiToken)),
      Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
      HttpRouter.toHttpEffect,
      Effect.map((httpEffect) =>
        httpEffect.pipe(
          Effect.provideService(DatabaseClient, databaseClient),
          Effect.catchIf(
            (error) => error.reason._tag === "RouteNotFound",
            () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          )
        )
      )
    );

    return {
      fetch: app,
    };
  }).pipe(
    Effect.provide([Cloudflare.D1.QueryDatabaseBinding, FetchHttpClient.layer])
  )
) {}
