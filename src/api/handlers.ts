import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import {
  createChannel,
  createMonitor,
  getMonitor,
  listChannels,
  listMonitors,
  removeChannel,
  removeMonitor,
  updateMonitor,
} from "./monitors.ts";
import { KanshiApi } from "./spec.ts";

export const MonitorsApiLive = HttpApiBuilder.group(
  KanshiApi,
  "monitors",
  (handlers) =>
    handlers
      .handle("list", () => listMonitors().pipe(Effect.orDie))
      .handle("create", ({ payload }) =>
        Effect.gen(function* CreateMonitorHandler() {
          const now = yield* Clock.currentTimeMillis;
          const monitor = yield* createMonitor(payload, now);
          return monitor ?? (yield* Effect.fail(new HttpApiError.Conflict()));
        }).pipe(
          Effect.catchTag("UrlValidationError", () =>
            Effect.fail(new HttpApiError.BadRequest())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("get", ({ params }) =>
        getMonitor(params.id).pipe(
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("update", ({ params, payload }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => updateMonitor(params.id, payload, now)),
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("UrlValidationError", () =>
            Effect.fail(new HttpApiError.BadRequest())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("remove", ({ params }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => removeMonitor(params.id, now)),
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("listChannels", ({ params }) =>
        listChannels(params.id).pipe(
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("createChannel", ({ params, payload }) =>
        createChannel(params.id, payload).pipe(
          Effect.catchTag("MonitorNotFound", () =>
            Effect.fail(new HttpApiError.NotFound())
          ),
          Effect.catchTag("UrlValidationError", () =>
            Effect.fail(new HttpApiError.BadRequest())
          ),
          Effect.catchTag("DatabaseError", Effect.die)
        )
      )
      .handle("removeChannel", ({ params }) =>
        removeChannel(params.id, params.channelId).pipe(
          Effect.orDie,
          Effect.flatMap((removed) =>
            removed ? Effect.void : Effect.fail(new HttpApiError.NotFound())
          )
        )
      )
);
