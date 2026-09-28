import type { MonitorSnapshot, MonitorSummary } from "../domain/monitor.ts";
import { summaryOf } from "../domain/monitor.ts";

/**
 * Pure watchdog rules: what the cron does with each Registry row, when a
 * monitor counts as "not being checked", and how the per-monitor stale
 * counter and alert episode move.
 */

/** A `creating` row older than this is finished or cleaned up. */
export const creatingGraceMs = 5 * 60_000;
/** Slack on top of two intervals before a monitor counts as stale. */
export const staleGraceMs = 2 * 60_000;
/** Consecutive stale watchdog runs before "not being checked" is sent. */
export const staleRunsToAlert = 2;
/** Rows processed at once by one watchdog run. */
export const watchdogConcurrency = 8;
/** Resolved episodes (and their alert rows) are kept this long. */
export const episodeRetentionMs = 30 * 24 * 60 * 60_000;

/** The fields of a Registry row the watchdog decides on. */
export interface WatchdogRow {
  readonly createdAt: number;
  readonly lifecycle: "active" | "creating" | "deleting";
  readonly opId: string;
}

/** The fields of a monitor's `status()` the watchdog decides on. */
export interface WatchdogStatus {
  readonly snapshot: MonitorSnapshot | null;
  readonly tombstonedAt: number | null;
}

/** What the watchdog saw of an active monitor, for the stale counter. */
export interface WatchObservation {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly lastCheckedAt: number | null;
  readonly name: string;
  readonly stale: boolean;
  readonly url: string;
}

export type WatchdogAction =
  /** A `creating` row younger than {@link creatingGraceMs}. */
  | { readonly _tag: "Wait" }
  /** A stuck create whose monitor was configured: finish it. */
  | { readonly _tag: "Activate"; readonly opId: string }
  /**
   * A stuck create whose monitor was never configured (or is already
   * tombstoned): run the delete path for that operation only.
   */
  | { readonly _tag: "Abandon"; readonly opId: string }
  /** A stuck delete: retry `destroy()` then `remove()`. */
  | { readonly _tag: "Destroy" }
  /** An active monitor: refresh its summary, re-arm, watch staleness. */
  | {
      readonly _tag: "Refresh";
      readonly observation: WatchObservation;
      readonly revision: number;
      readonly summary: MonitorSummary;
    }
  /** Nothing safe to do (logged). */
  | { readonly _tag: "Skip"; readonly reason: string };

/** Whether deciding on `row` needs the monitor's `status()`. */
export const needsStatus = (row: WatchdogRow, now: number): boolean =>
  row.lifecycle === "active" ||
  (row.lifecycle === "creating" && now - row.createdAt >= creatingGraceMs);

/** How long an enabled monitor may go without a check. */
export const staleThresholdMs = (intervalSeconds: number): number =>
  2 * intervalSeconds * 1000 + staleGraceMs;

/**
 * The last time the monitor was known to be checked, created, or had its
 * check schedule restarted (enable or probe-affecting edit). Cosmetic edits
 * (name, channels, public, managed) bump `updatedAt` but do not restart the
 * schedule, so they must not restart the clock.
 */
export const lastSignOfLife = (snapshot: MonitorSnapshot): number =>
  Math.max(
    snapshot.state.lastCheckedAt ?? 0,
    snapshot.config.createdAt,
    snapshot.state.scheduleResetAt
  );

/** Enabled, and no check for more than two intervals plus two minutes. */
export const isStale = (snapshot: MonitorSnapshot, now: number): boolean =>
  snapshot.config.enabled &&
  now - lastSignOfLife(snapshot) >
    staleThresholdMs(snapshot.config.intervalSeconds);

export const observe = (
  snapshot: MonitorSnapshot,
  now: number
): WatchObservation => ({
  enabled: snapshot.config.enabled,
  intervalSeconds: snapshot.config.intervalSeconds,
  lastCheckedAt: snapshot.state.lastCheckedAt,
  name: snapshot.config.name,
  stale: isStale(snapshot, now),
  url: snapshot.config.url,
});

/**
 * What the watchdog does with one Registry row. `status` is the monitor's
 * `status()`, or null when it was not needed ({@link needsStatus}) or could
 * not be fetched.
 */
export const decide = (
  row: WatchdogRow,
  status: WatchdogStatus | null,
  now: number
): WatchdogAction => {
  switch (row.lifecycle) {
    case "deleting": {
      return { _tag: "Destroy" };
    }
    case "creating": {
      if (now - row.createdAt < creatingGraceMs) {
        return { _tag: "Wait" };
      }
      if (status === null) {
        return { _tag: "Skip", reason: "monitor status unavailable" };
      }
      return status.snapshot !== null && status.tombstonedAt === null
        ? { _tag: "Activate", opId: row.opId }
        : { _tag: "Abandon", opId: row.opId };
    }
    case "active": {
      if (status === null) {
        return { _tag: "Skip", reason: "monitor status unavailable" };
      }
      if (status.tombstonedAt !== null) {
        return {
          _tag: "Skip",
          reason: "the row is active but its monitor was deleted",
        };
      }
      if (status.snapshot === null) {
        return {
          _tag: "Skip",
          reason: "the row is active but its monitor is not configured",
        };
      }
      return {
        _tag: "Refresh",
        observation: observe(status.snapshot, now),
        revision: status.snapshot.state.summaryRevision,
        summary: summaryOf(status.snapshot.config, status.snapshot.state),
      };
    }
    default: {
      return row.lifecycle satisfies never;
    }
  }
};

/** The durable per-monitor watchdog state kept in the Registry row. */
export interface WatchState {
  /** Consecutive runs that found the monitor stale. */
  readonly staleRuns: number;
  /** The open "not being checked" episode, if an alert went out. */
  readonly episodeId: string | null;
}

/**
 * - `open`: start an episode and alert every channel.
 * - `resolve`: checks resumed; send the recovery to the channels alerted.
 * - `close`: the monitor was disabled; end the episode without a message.
 */
export type WatchChange = "close" | "none" | "open" | "resolve";

/**
 * Advance the stale counter by one watchdog run. An episode opens on the
 * {@link staleRunsToAlert}th consecutive stale run and stays open (no new
 * alert) until a run finds the monitor checked again or disabled.
 */
export const watchTransition = (
  previous: WatchState,
  observation: Pick<WatchObservation, "enabled" | "stale">
): { readonly change: WatchChange; readonly staleRuns: number } => {
  const open = previous.episodeId !== null;
  if (!observation.enabled) {
    return { change: open ? "close" : "none", staleRuns: 0 };
  }
  if (!observation.stale) {
    return { change: open ? "resolve" : "none", staleRuns: 0 };
  }
  const staleRuns = previous.staleRuns + 1;
  return {
    change: !open && staleRuns >= staleRunsToAlert ? "open" : "none",
    staleRuns,
  };
};
