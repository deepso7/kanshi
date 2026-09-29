import * as Schema from "effect/Schema";

import { IncidentResolution } from "./monitor.ts";

/**
 * A "not being checked" episode, the watchdog's incident: opened when a
 * monitor's checks are overdue, resolved when they resume (or the monitor
 * is disabled or deleted). Stored by the Registry.
 */
export const Episode = Schema.Struct({
  id: Schema.String,
  intervalSeconds: Schema.Number,
  lastCheckedAt: Schema.NullOr(Schema.Number),
  monitorId: Schema.String,
  monitorName: Schema.String,
  monitorUrl: Schema.String,
  resolution: Schema.NullOr(IncidentResolution),
  resolvedAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.Number,
});
export type Episode = typeof Episode.Type;
