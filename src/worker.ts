import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { ApiAuthLive, credentialValidatorLayer } from "./api/auth.ts";
import { makeChannelsHandlers } from "./api/channels.ts";
import { makeMonitorsHandlers } from "./api/handlers.ts";
import { KanshiApi } from "./api/spec.ts";
import { makeDevRoutes } from "./dev/routes.ts";
import { Monitor, MonitorLive } from "./monitor/monitor.ts";
import { Registry, RegistryLive } from "./registry/registry.ts";
import { makeChannelService } from "./service/channels.ts";
import { makeMonitorService } from "./service/monitors.ts";
import { runWatchdog } from "./watchdog/run.ts";

/** The watchdog's Cron Trigger. */
export const watchdogCron = "*/5 * * * *";

// Workers have no file system; the API never serves files.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
  platform: "web",
});

/**
 * The single Kanshi Worker: the `/api` HttpApi, the watchdog cron and, in
 * the dev stage, the `/_dev/*` fixtures. It hosts the Monitor and Registry
 * Durable Objects.
 *
 * Config (read at deploy time and bound to the Worker):
 * - `KANSHI_API_TOKEN` bearer token for `/api` (required)
 * - `KANSHI_DEV_MODE` set by the stack for the dev stage
 * - `KANSHI_MONITOR_QUOTA` maximum number of monitors (default 100)
 */
export default class Kanshi extends Cloudflare.Worker<Kanshi>()(
  "Kanshi",
  {
    dev: {
      port: Config.Number("PORT").pipe(Config.withDefault(1337)),
    },
    main: import.meta.url,
  },
  Effect.gen(function* KanshiInit() {
    const apiToken = yield* Config.Redacted("KANSHI_API_TOKEN");
    if (Redacted.value(apiToken).trim().length === 0) {
      return yield* Effect.die(new Error("KANSHI_API_TOKEN must not be empty"));
    }
    const devMode = yield* Config.Boolean("KANSHI_DEV_MODE").pipe(
      Config.withDefault(false)
    );
    const quota = yield* Config.Int("KANSHI_MONITOR_QUOTA").pipe(
      Config.withDefault(100)
    );
    const monitors = yield* Monitor;
    const registries = yield* Registry;

    yield* Cloudflare.Workers.cron(watchdogCron, () =>
      Effect.suspend(() =>
        runWatchdog({ monitors, registries }, Date.now())
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("watchdog run failed", cause)
        ),
        Effect.asVoid
      )
    );

    const monitorService = makeMonitorService({
      devMode,
      monitors,
      quota,
      registries,
    });
    const channelService = makeChannelService({ devMode, registries });

    const api = HttpApiBuilder.layer(KanshiApi).pipe(
      Layer.provide([
        makeMonitorsHandlers(monitorService),
        makeChannelsHandlers(channelService),
      ]),
      Layer.provide(ApiAuthLive),
      Layer.provide(credentialValidatorLayer(apiToken)),
      Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
      HttpRouter.toHttpEffect
    );
    const dev = makeDevRoutes({ monitors, registries });

    return {
      fetch: Effect.map(api, (apiHttp) => {
        const apiOr404 = apiHttp.pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "RouteNotFound",
            () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))
          )
        );
        return Effect.gen(function* route() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { pathname } = new URL(request.url, "http://internal");
          if (devMode && pathname.startsWith("/_dev/")) {
            return yield* dev;
          }
          return yield* apiOr404;
        });
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.provide(MonitorLive.pipe(Layer.provideMerge(RegistryLive)))
  )
) {}
