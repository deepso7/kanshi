import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { ApiAuthLive, credentialValidatorLayer } from "./api/auth.ts";
import { ChannelsHandlers } from "./api/channels.ts";
import {
  DevHandlers,
  MetaHandlers,
  OverviewHandlers,
  WatchdogHandlers,
} from "./api/dashboard.ts";
import { MonitorsHandlers } from "./api/handlers.ts";
import { PublicHandlers } from "./api/public.ts";
import { SessionHandlers } from "./api/session.ts";
import { KanshiApi } from "./api/spec.ts";
import { DevRoutes, isLoopbackHost } from "./dev/routes.ts";
import { guardBody } from "./http/body-limit.ts";
import { localRunWorkerFirst, runWorkerFirst } from "./http/worker-paths.ts";
import { Monitor, MonitorLive } from "./monitor/monitor.ts";
import { Registry, RegistryLive } from "./registry/registry.ts";
import { ChannelService } from "./service/channels.ts";
import { DevService } from "./service/dev.ts";
import { MonitorService } from "./service/monitors.ts";
import { StatusService } from "./service/status.ts";
import { KanshiSettings } from "./settings.ts";
import { runWatchdog } from "./watchdog/run.ts";

/**
 * The SPA's build output (`pnpm build`, run by `pnpm run deploy` and
 * `pnpm test:integ`), relative to the directory alchemy runs in.
 */
export const webAssetsDirectory = "web/dist";

/**
 * The watchdog's Cron Trigger: hourly, off the hour. It re-arms lost
 * alarms, converges lost summary pushes and finds monitors that stopped
 * being checked, so a silently stuck monitor is noticed within 1-2 hours.
 */
export const watchdogCron = "17 * * * *";

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

/** The services behind `/api` and `/_dev`, built once per isolate. */
const ServicesLive = DevRoutes.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      MonitorService.layer,
      ChannelService.layer,
      DevService.layer,
      StatusService.layer
    )
  ),
  Layer.provideMerge(KanshiSettings.layer)
);

/**
 * The single Kanshi Worker: the SPA (static assets), the `/api` HttpApi,
 * the watchdog cron and, in the dev stage, the `/_dev/*` fixtures. It
 * hosts the Monitor and Registry Durable Objects. Its config is read by
 * {@link KanshiSettings}.
 */
export default class Kanshi extends Cloudflare.Worker<Kanshi>()(
  "Kanshi",
  Effect.gen(function* KanshiProps() {
    const local = (yield* Alchemy.ProviderMode.defaultProviderMode) === "local";
    return {
      // The SPA is served by Cloudflare's asset layer; unknown paths get
      // `index.html`. The Worker only runs for its own paths.
      assets: {
        directory: webAssetsDirectory,
        notFoundHandling: "single-page-application",
        runWorkerFirst: local ? localRunWorkerFirst : runWorkerFirst,
      },
      dev: {
        port: Config.Number("PORT").pipe(Config.withDefault(1337)),
      },
      main: import.meta.url,
    };
  }),
  Effect.gen(function* KanshiInit() {
    const { apiToken, devMode } = yield* KanshiSettings;
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

    const services = yield* Effect.context<
      | ChannelService
      | DevService
      | KanshiSettings
      | MonitorService
      | StatusService
    >();
    const api = HttpApiBuilder.layer(KanshiApi).pipe(
      Layer.provide([
        MonitorsHandlers,
        ChannelsHandlers,
        OverviewHandlers,
        WatchdogHandlers,
        DevHandlers,
        MetaHandlers,
        PublicHandlers,
        SessionHandlers,
      ]),
      Layer.provide(ApiAuthLive),
      Layer.provide(credentialValidatorLayer(apiToken)),
      Layer.provide([
        Etag.layer,
        HttpPlatformStub,
        Path.layer,
        Layer.succeedContext(services),
      ]),
      HttpRouter.toHttpEffect
    );
    const dev = yield* DevRoutes;

    return {
      fetch: api.pipe(
        Effect.map((apiHttp) => {
          const apiOr404 = apiHttp.pipe(
            Effect.catchReason("HttpServerError", "RouteNotFound", () =>
              Effect.succeed(HttpServerResponse.empty({ status: 404 }))
            )
          );
          return Effect.gen(function* route() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const { pathname } = new URL(request.url, "http://internal");
            if (pathname === "/api" || pathname.startsWith("/api/")) {
              // Bodies read without auth are capped (and Origin-checked)
              // before the API decodes them.
              return yield* guardBody(request, pathname, apiOr404);
            }
            // Dev fixtures are unauthenticated: local dev only, and only for
            // requests addressed to a loopback host.
            if (
              devMode &&
              pathname.startsWith("/_dev/") &&
              isLoopbackHost(request.headers.host)
            ) {
              return yield* dev;
            }
            // Everything else is the SPA's (static assets); a path that
            // reaches the Worker anyway has no page here.
            return HttpServerResponse.empty({ status: 404 });
          });
        })
      ),
    };
  }).pipe(
    Effect.provide(ServicesLive),
    Effect.provide(Cloudflare.Workers.CronEventSourceLive),
    Effect.provide(MonitorLive.pipe(Layer.provideMerge(RegistryLive)))
  )
) {}
