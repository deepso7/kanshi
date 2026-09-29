// The dashboard's reads beyond the monitor and channel resources: the
// overview, the watchdog's open episodes, dev events and meta.
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { minIntervalSeconds } from "../domain/monitor-input.ts";
import { DevService } from "../service/dev.ts";
import { MonitorService } from "../service/monitors.ts";
import { KanshiSettings } from "../settings.ts";
import {
  KanshiApi,
  defaultDevEventsLimit,
  defaultRecentBuckets,
  defaultRecentHours,
} from "./spec.ts";

/** `GET /api/overview`: every monitor and its recent activity. */
export const OverviewHandlers = HttpApiBuilder.group(
  KanshiApi,
  "overview",
  Effect.fnUntraced(function* overviewHandlers(handlers) {
    const service = yield* MonitorService;
    return handlers.handle("get", ({ query }) =>
      service.overview({
        buckets: query.buckets ?? defaultRecentBuckets,
        hours: query.hours ?? defaultRecentHours,
      })
    );
  })
);

/** `GET /api/watchdog/episodes`: open "not being checked" episodes. */
export const WatchdogHandlers = HttpApiBuilder.group(
  KanshiApi,
  "watchdog",
  Effect.fnUntraced(function* watchdogHandlers(handlers) {
    const service = yield* MonitorService;
    return handlers.handle("episodes", () => service.openEpisodes());
  })
);

/** `GET /api/dev/events`: the dev webhook sink (404 outside dev mode). */
export const DevHandlers = HttpApiBuilder.group(
  KanshiApi,
  "dev",
  Effect.fnUntraced(function* devHandlers(handlers) {
    const service = yield* DevService;
    return handlers.handle("events", ({ query }) =>
      service.events(query.limit ?? defaultDevEventsLimit)
    );
  })
);

/** `GET /api/meta`: dev mode, the minimum interval and the quota. */
export const MetaHandlers = HttpApiBuilder.group(
  KanshiApi,
  "meta",
  Effect.fnUntraced(function* metaHandlers(handlers) {
    const { devMode, quota } = yield* KanshiSettings;
    return handlers.handle("get", () =>
      Effect.succeed({
        devMode,
        minIntervalSeconds: minIntervalSeconds(devMode),
        monitorQuota: quota,
      })
    );
  })
);
