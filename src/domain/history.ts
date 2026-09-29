import * as Schema from "effect/Schema";

import { OutboxEntry } from "./alert.ts";
import { CheckKind, IncidentResolution, ProbeOutcome } from "./monitor.ts";

/** One stored check. Only `counted` checks are uptime samples. */
export const Check = Schema.Struct({
  ...ProbeOutcome.fields,
  at: Schema.Number,
  checkId: Schema.String,
  counted: Schema.Boolean,
  kind: CheckKind,
});
export type Check = typeof Check.Type;

export const Incident = Schema.Struct({
  cause: Schema.String,
  id: Schema.String,
  lastHttpStatus: Schema.NullOr(Schema.Number),
  resolution: Schema.NullOr(IncidentResolution),
  resolvedAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.Number,
});
export type Incident = typeof Incident.Type;

/** An incident with its alert rows (one per event and channel). */
export const IncidentWithAlerts = Schema.Struct({
  ...Incident.fields,
  alerts: Schema.Array(OutboxEntry),
});
export type IncidentWithAlerts = typeof IncidentWithAlerts.Type;

/** One UTC day of counted samples. */
export const DailyRollup = Schema.Struct({
  counted: Schema.Number,
  day: Schema.String,
  down: Schema.Number,
  expected: Schema.Number,
  /** Latency percentiles (ms) of successful counted samples. */
  p50: Schema.NullOr(Schema.Number),
  p95: Schema.NullOr(Schema.Number),
  up: Schema.Number,
});
export type DailyRollup = typeof DailyRollup.Type;

export const UptimeDay = Schema.Struct({
  ...DailyRollup.fields,
  /** Computed on read (today, or a closed day not rolled up yet). */
  live: Schema.Boolean,
  /** Fewer than 80% of the expected samples were taken. */
  partial: Schema.Boolean,
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type UptimeDay = typeof UptimeDay.Type;

/** Up share in percent (three decimals); null without samples. */
export const uptimePercent = (up: number, counted: number): number | null =>
  counted === 0 ? null : Math.round((up / counted) * 100_000) / 1000;

/**
 * Uptime over the last `count` of `days` (oldest first), weighted by
 * samples like a report's overall uptime: what bars showing those days
 * add up to.
 */
export const uptimeOfLastDays = (
  days: readonly Pick<DailyRollup, "counted" | "up">[],
  count: number
): number | null => {
  const shown = days.slice(-count);
  return uptimePercent(
    shown.reduce((sum, day) => sum + day.up, 0),
    shown.reduce((sum, day) => sum + day.counted, 0)
  );
};

export const UptimeReport = Schema.Struct({
  counted: Schema.Number,
  /** Oldest first, today last. */
  days: Schema.Array(UptimeDay),
  expected: Schema.Number,
  up: Schema.Number,
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type UptimeReport = typeof UptimeReport.Type;

/** One time bucket of recent checks, for the dashboard's sparkline. */
export const RecentBucket = Schema.Struct({
  /** Bucket start (epoch ms). */
  at: Schema.Number,
  /** Counted failures in the bucket. */
  failures: Schema.Number,
  /** Mean latency (ms) of the successful checks, null without any. */
  latencyMs: Schema.NullOr(Schema.Number),
});
export type RecentBucket = typeof RecentBucket.Type;

/** Counted samples and latency buckets since a point in time. */
export const RecentActivity = Schema.Struct({
  /** Oldest first; one per bucket, empty buckets included. */
  buckets: Schema.Array(RecentBucket),
  counted: Schema.Number,
  up: Schema.Number,
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type RecentActivity = typeof RecentActivity.Type;
