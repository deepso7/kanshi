// Pure summaries of the overview's recent activity (`GET /api/overview`):
// the fleet's combined uptime, a row's latency line and the tone of an
// uptime figure. Shared by the dashboard's stat cards and rows.
import { degradedThreshold, upThreshold } from "./uptime-bars.tsx";

/** The part of `RecentActivity` these read. */
export interface RecentSample {
  readonly buckets: readonly { readonly latencyMs: number | null }[];
  readonly counted: number;
  readonly up: number;
}

/**
 * Uptime over every monitor's window, weighted by samples (a monitor
 * checked every 10 s counts more than one checked hourly), or `null` with
 * no samples at all. Monitors that could not be read (`null`) are skipped.
 */
export const combinedUptime = (
  recents: readonly (RecentSample | null)[]
): number | null => {
  let counted = 0;
  let up = 0;
  for (const recent of recents) {
    if (recent !== null) {
      counted += recent.counted;
      up += recent.up;
    }
  }
  return counted === 0 ? null : (up / counted) * 100;
};

/** The sparkline's values: mean latency per bucket, oldest first. */
export const latencyValues = (
  recent: RecentSample | null
): readonly (number | null)[] =>
  recent === null ? [] : recent.buckets.map((bucket) => bucket.latencyMs);

/** The most recent bucket with a latency, or `null`. */
export const latestLatency = (recent: RecentSample | null): number | null =>
  latencyValues(recent).findLast((value) => value !== null) ?? null;

/** Lowest and highest bucket latency, or `null` without any. */
export const latencyRange = (
  recent: RecentSample | null
): { readonly max: number; readonly min: number } | null => {
  const known = latencyValues(recent).filter((value) => value !== null);
  if (known.length === 0) {
    return null;
  }
  return { max: Math.max(...known), min: Math.min(...known) };
};

export type UptimeTone = "success" | "warning" | "danger" | "muted";

/** The same grades as the uptime bars: good, degraded, down; muted: none. */
export const uptimeTone = (percent: number | null): UptimeTone => {
  if (percent === null) {
    return "muted";
  }
  if (percent >= upThreshold) {
    return "success";
  }
  return percent >= degradedThreshold ? "warning" : "danger";
};
