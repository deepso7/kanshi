import * as DateTime from "effect/DateTime";

import type {
  DailyRollup,
  RecentActivity,
  RecentBucket,
  UptimeDay,
  UptimeReport,
} from "../domain/history.ts";
import { uptimePercent } from "../domain/history.ts";

/**
 * History and uptime, all pure. Days are UTC calendar days (`YYYY-MM-DD`).
 *
 * - Only `counted` checks (one per scheduled slot) are samples.
 * - `expected` for a day is the enabled time that day divided by the
 *   interval in force, from the enabled-periods log kept on config changes.
 * - A day is `partial` when it has fewer than 80% of its expected samples.
 * - Maintenance rolls closed days up into `daily_rollups`, advancing the
 *   `rolledUpThrough` watermark in the same transaction, then prunes raw
 *   checks (rolled up and older than 30 days) and resolved incidents with
 *   their alert rows (older than 90 days).
 */

export const dayMs = 24 * 60 * 60 * 1000;
/** Raw checks are kept this long (and always until rolled up). */
export const checksRetentionDays = 30;
/** Resolved incidents and their alert rows are kept this long. */
export const incidentsRetentionDays = 90;
/** Maintenance runs this long after UTC midnight. */
export const maintenanceOffsetMs = 5 * 60 * 1000;
/** Days rolled up per maintenance run; the rest runs right after. */
export const maxRollupDaysPerRun = 31;
/** A day with fewer counted samples than this share of expected is partial. */
export const partialThreshold = 0.8;

/** The UTC day of a timestamp. */
export const dayOf = (at: number): string =>
  DateTime.formatIsoDateUtc(DateTime.makeUnsafe(at));

/** Midnight UTC starting `day`. */
export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export const addDays = (day: string, days: number): string =>
  dayOf(dayStart(day) + days * dayMs);

/** The next maintenance time strictly after `now`. */
export const nextMaintenanceTime = (now: number): number => {
  const today = dayStart(dayOf(now)) + maintenanceOffsetMs;
  return today > now ? today : today + dayMs;
};

/** Nearest-rank percentile of ascending `sorted`; null when empty. */
export const percentile = (
  sorted: readonly number[],
  quantile: number
): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil(quantile * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
};

/** A span during which the monitor was enabled with one interval. */
export interface EnabledPeriod {
  readonly endedAt: number | null;
  readonly intervalSeconds: number;
  readonly startedAt: number;
}

/** What the enabled-periods log needs after a config change. */
export interface PeriodChange {
  /** Close the open period (if any) at the change time. */
  readonly close: boolean;
  /** Open a new period with this interval at the change time. */
  readonly open: { readonly intervalSeconds: number } | null;
}

type PeriodConfig = {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
} | null;

/**
 * The period log change for a config transition; null config means the
 * monitor does not exist (before create, after delete). Only `enabled` and
 * `intervalSeconds` matter.
 */
export const periodChange = (
  before: PeriodConfig,
  after: PeriodConfig
): PeriodChange => {
  const wasOn = before?.enabled === true;
  const isOn = after?.enabled === true;
  if (wasOn && isOn && before.intervalSeconds === after.intervalSeconds) {
    return { close: false, open: null };
  }
  return {
    close: wasOn,
    open: isOn ? { intervalSeconds: after.intervalSeconds } : null,
  };
};

/** Expected samples in `[from, to)`: enabled time over the interval. */
export const expectedSamples = (
  periods: readonly EnabledPeriod[],
  from: number,
  to: number
): number => {
  let total = 0;
  for (const period of periods) {
    const start = Math.max(from, period.startedAt);
    const end = Math.min(to, period.endedAt ?? to);
    if (end > start && period.intervalSeconds > 0) {
      total += (end - start) / (period.intervalSeconds * 1000);
    }
  }
  return Math.round(total * 100) / 100;
};

/** One counted check. */
export interface Sample {
  readonly latencyMs: number | null;
  readonly ok: boolean;
}

/**
 * Roll one day up. `until` cuts the day short (today, computed on read):
 * expected samples only accrue up to it.
 */
export const rollupDay = (
  day: string,
  samples: readonly Sample[],
  periods: readonly EnabledPeriod[],
  until?: number
): DailyRollup => {
  const start = dayStart(day);
  const end = Math.min(start + dayMs, until ?? Number.POSITIVE_INFINITY);
  const up = samples.filter((sample) => sample.ok).length;
  const latencies = samples
    .filter((sample) => sample.ok && sample.latencyMs !== null)
    .map((sample) => sample.latencyMs ?? 0)
    .toSorted((left, right) => left - right);
  return {
    counted: samples.length,
    day,
    down: samples.length - up,
    expected: expectedSamples(periods, start, Math.max(start, end)),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    up,
  };
};

/** Fewer than 80% of the expected samples were taken. */
export const isPartial = (
  rollup: Pick<DailyRollup, "counted" | "expected">
): boolean => rollup.counted < partialThreshold * rollup.expected;

/**
 * Closed days still to roll up, oldest first: after the watermark (or from
 * the creation day), every day that ended at or before `now`, at most
 * `max`.
 */
export const daysToRollUp = (
  rolledUpThrough: string | null,
  createdAt: number,
  now: number,
  max = maxRollupDaysPerRun
): readonly string[] => {
  const days: string[] = [];
  let day =
    rolledUpThrough === null ? dayOf(createdAt) : addDays(rolledUpThrough, 1);
  while (days.length < max && dayStart(day) + dayMs <= now) {
    days.push(day);
    day = addDays(day, 1);
  }
  return days;
};

/**
 * Raw checks before this time may be pruned: they are rolled up (their day
 * is at or before the watermark) and their day ended 30 days before today.
 * Null when nothing is rolled up yet.
 */
export const checksPruneBefore = (
  rolledUpThrough: string | null,
  now: number
): number | null =>
  rolledUpThrough === null
    ? null
    : Math.min(
        dayStart(rolledUpThrough) + dayMs,
        dayStart(dayOf(now)) - checksRetentionDays * dayMs
      );

/** Incidents resolved before this time are pruned with their alert rows. */
export const incidentsPruneBefore = (now: number): number =>
  now - incidentsRetentionDays * dayMs;

export const uptimeDay = (rollup: DailyRollup, live: boolean): UptimeDay => ({
  ...rollup,
  live,
  partial: isPartial(rollup),
  uptimePercent: uptimePercent(rollup.up, rollup.counted),
});

/** Overall uptime over the listed days. */
export const uptimeReport = (days: readonly UptimeDay[]): UptimeReport => {
  const counted = days.reduce((sum, day) => sum + day.counted, 0);
  const up = days.reduce((sum, day) => sum + day.up, 0);
  const expected = days.reduce((sum, day) => sum + day.expected, 0);
  return {
    counted,
    days,
    expected: Math.round(expected * 100) / 100,
    up,
    uptimePercent: uptimePercent(up, counted),
  };
};

/**
 * The days an uptime report covers: the last `days` days through today,
 * not before the monitor's creation day. Oldest first.
 */
export const reportDays = (
  days: number,
  createdAt: number,
  now: number
): readonly string[] => {
  const today = dayOf(now);
  const first = dayOf(createdAt);
  const result: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    if (day >= first) {
      result.push(day);
    }
  }
  return result;
};

/** The dashboard's window: the last 24 hours in 48 half-hour buckets. */
export const recentWindowMs = dayMs;
export const recentBuckets = 48;

export interface RecentRows {
  readonly buckets: readonly {
    readonly bucket: number;
    readonly failures: number | null;
    readonly latencyMs: number | null;
  }[];
  readonly counted: number;
  readonly up: number;
}

/**
 * Assemble `count` buckets of `bucketMs` from `since`, oldest first,
 * filling the buckets without checks. Mean latencies are rounded to ms.
 */
export const recentActivity = (
  since: number,
  bucketMs: number,
  count: number,
  rows: RecentRows
): RecentActivity => {
  const byIndex = new Map(rows.buckets.map((row) => [row.bucket, row]));
  const buckets = Array.from({ length: count }, (_, index): RecentBucket => {
    const row = byIndex.get(index);
    return {
      at: since + index * bucketMs,
      failures: row?.failures ?? 0,
      latencyMs:
        row?.latencyMs === null || row?.latencyMs === undefined
          ? null
          : Math.round(row.latencyMs),
    };
  });
  return {
    buckets,
    counted: rows.counted,
    up: rows.up,
    uptimePercent: uptimePercent(rows.up, rows.counted),
  };
};
