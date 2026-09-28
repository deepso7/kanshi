import * as Schema from "effect/Schema";

/**
 * What the public status page and `GET /api/public/status` show. Only
 * monitors that are `public` right now; never URLs, ids, keys or failure
 * details.
 */
export const PublicMonitorStatus = Schema.Literals([
  "up",
  "down",
  "unknown",
  "paused",
]);
export type PublicMonitorStatus = typeof PublicMonitorStatus.Type;

export const OverallStatus = Schema.Literals([
  "operational",
  "partial_outage",
  "major_outage",
]);
export type OverallStatus = typeof OverallStatus.Type;

export const PublicDay = Schema.Struct({
  day: Schema.String,
  partial: Schema.Boolean,
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type PublicDay = typeof PublicDay.Type;

export const PublicMonitor = Schema.Struct({
  /** Oldest first; empty when the history could not be read. */
  days: Schema.Array(PublicDay),
  /** Start of the open incident, if the monitor is down. */
  downSince: Schema.NullOr(Schema.Number),
  lastCheckedAt: Schema.NullOr(Schema.Number),
  name: Schema.String,
  status: PublicMonitorStatus,
  /** Over the reported days. */
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type PublicMonitor = typeof PublicMonitor.Type;

export const PublicStatus = Schema.Struct({
  generatedAt: Schema.Number,
  monitors: Schema.Array(PublicMonitor),
  overall: OverallStatus,
});
export type PublicStatus = typeof PublicStatus.Type;

/** No monitor down: operational; every active monitor down: major. */
export const overallStatus = (
  monitors: readonly Pick<PublicMonitor, "status">[]
): OverallStatus => {
  const watched = monitors.filter((monitor) => monitor.status !== "paused");
  const down = watched.filter((monitor) => monitor.status === "down").length;
  if (down === 0) {
    return "operational";
  }
  return down === watched.length ? "major_outage" : "partial_outage";
};
