import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import type { MonitorService } from "../service/monitors.ts";
import {
  KanshiApi,
  defaultChecksLimit,
  defaultIncidentsLimit,
  defaultUptimeDays,
} from "./spec.ts";

/** Dev stage only: delay between `registry.begin` and `configure`. */
export const devConfigureDelayHeader = "x-kanshi-dev-configure-delay";
/**
 * Dev stage only: stop after `configure`, leaving the row `creating` (a
 * create that died before `activate`; the watchdog finishes it). The
 * reply is the usual 201 with the configured monitor.
 */
export const devSkipActivateHeader = "x-kanshi-dev-skip-activate";

export const makeMonitorsHandlers = (service: MonitorService) =>
  HttpApiBuilder.group(KanshiApi, "monitors", (handlers) =>
    handlers
      .handle("list", () =>
        service
          .list()
          .pipe(Effect.map((entries) => entries.map(service.toListItem)))
      )
      .handle("create", ({ payload, request }) =>
        service.create(payload, {
          configureDelayMs:
            Number(request.headers[devConfigureDelayHeader]) || 0,
          skipActivate: request.headers[devSkipActivateHeader] === "1",
        })
      )
      .handle("get", ({ params }) => service.get(params.id))
      .handle("update", ({ params, payload }) =>
        service.update(params.id, payload)
      )
      .handle("remove", ({ params }) => service.remove(params.id))
      .handle("check", ({ params }) => service.check(params.id))
      .handle("checks", ({ params, query }) =>
        service.checks(params.id, {
          limit: query.limit ?? defaultChecksLimit,
          since: query.since,
        })
      )
      .handle("uptime", ({ params, query }) =>
        service.uptime(params.id, query.days ?? defaultUptimeDays)
      )
      .handle("incidents", ({ params, query }) =>
        service.incidents(params.id, query.limit ?? defaultIncidentsLimit)
      )
  );
