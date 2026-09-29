import * as Data from "effect/Data";

import type { MonitorSnapshot, MonitorSummary } from "../domain/monitor.ts";
import { summaryOf } from "../domain/monitor.ts";

/**
 * Pure watchdog rules: what the hourly cron does with each Registry row,
 * when a monitor counts as "not being checked", and how its alert episode
 * moves.
 */

/** A `creating` row older than this is finished or cleaned up. */
export const creatingGraceMs = 5 * 60_000;
/** Slack on top of two intervals before a monitor counts as stale. */
export const staleGraceMs = 2 * 60_000;
/**
 * The least time without a check that counts as stale, whatever the
 * interval: one stale observation opens an episode, so short intervals
 * (and the 5s dev ones) must not alert on a brief hiccup.
 */
export const staleFloorMs = 10 * 60_000;
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

/** The fields of a monitor's `reconcile()` the watchdog decides on. */
export interface WatchdogStatus {
  readonly snapshot: MonitorSnapshot | null;
  readonly tombstonedAt: number | null;
}

/** What the watchdog saw of an active monitor, for its episode. */
export interface WatchObservation {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly lastCheckedAt: number | null;
  readonly name: string;
  readonly stale: boolean;
  readonly url: string;
}

export type WatchdogAction = Data.TaggedEnum<{
  /** A `creating` row younger than {@link creatingGraceMs}. */
  Wait: Record<never, never>;
  /** A stuck create whose monitor was configured: finish it. */
  Activate: { readonly opId: string };
  /**
   * A stuck create whose monitor was never configured (or is already
   * tombstoned): run the delete path for that operation only.
   */
  Abandon: { readonly opId: string };
  /** A stuck delete: retry `destroy()` then `remove()`. */
  Destroy: Record<never, never>;
  /** An active monitor: refresh its summary, re-arm, watch staleness. */
  Refresh: {
    readonly observation: WatchObservation;
    readonly revision: number;
    readonly summary: MonitorSummary;
  };
  /** Nothing safe to do (logged). */
  Skip: { readonly reason: string };
}>;

export const WatchdogAction = Data.taggedEnum<WatchdogAction>();

/**
 * One active monitor's refresh, sent to the Registry with every other in
 * one batched call: its summary (revision-checked) and the observation
 * that opens, resolves or closes its "not being checked" episode.
 */
export interface ReconcileItem {
  readonly id: string;
  readonly observation: WatchObservation;
  readonly revision: number;
  readonly summary: MonitorSummary;
}

/**
 * Whether deciding on `row` needs the monitor's `reconcile()` (its one
 * call per run, which also re-arms its alarm).
 */
export const needsReconcile = (row: WatchdogRow, now: number): boolean =>
  row.lifecycle === "active" ||
  (row.lifecycle === "creating" && now - row.createdAt >= creatingGraceMs);

/**
 * How long an enabled monitor may go without a check: two intervals plus
 * two minutes, and at least {@link staleFloorMs}.
 */
export const staleThresholdMs = (intervalSeconds: number): number =>
  Math.max(2 * intervalSeconds * 1000 + staleGraceMs, staleFloorMs);

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

/** Enabled, and no check for longer than {@link staleThresholdMs}. */
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
 * `reconcile()`, or null when it was not needed ({@link needsReconcile}) or
 * could not be fetched.
 */
export const decide = (
  row: WatchdogRow,
  status: WatchdogStatus | null,
  now: number
): WatchdogAction => {
  switch (row.lifecycle) {
    case "deleting": {
      return WatchdogAction.Destroy();
    }
    case "creating": {
      if (now - row.createdAt < creatingGraceMs) {
        return WatchdogAction.Wait();
      }
      if (status === null) {
        return WatchdogAction.Skip({ reason: "monitor status unavailable" });
      }
      return status.snapshot !== null && status.tombstonedAt === null
        ? WatchdogAction.Activate({ opId: row.opId })
        : WatchdogAction.Abandon({ opId: row.opId });
    }
    case "active": {
      if (status === null) {
        return WatchdogAction.Skip({ reason: "monitor status unavailable" });
      }
      if (status.tombstonedAt !== null) {
        return WatchdogAction.Skip({
          reason: "the row is active but its monitor was deleted",
        });
      }
      if (status.snapshot === null) {
        return WatchdogAction.Skip({
          reason: "the row is active but its monitor is not configured",
        });
      }
      return WatchdogAction.Refresh({
        observation: observe(status.snapshot, now),
        revision: status.snapshot.state.summaryRevision,
        summary: summaryOf(status.snapshot.config, status.snapshot.state),
      });
    }
    default: {
      return row.lifecycle satisfies never;
    }
  }
};

/** The durable per-monitor watchdog state kept in the Registry row. */
export interface WatchState {
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
 * One watchdog observation's effect on the monitor's episode. A single
 * stale observation opens one (the run is hourly, and the threshold is
 * already several intervals); it stays open, with no further alert, until
 * an observation finds the monitor checked again or disabled.
 */
export const watchTransition = (
  previous: WatchState,
  observation: Pick<WatchObservation, "enabled" | "stale">
): WatchChange => {
  const open = previous.episodeId !== null;
  if (!observation.enabled) {
    return open ? "close" : "none";
  }
  if (!observation.stale) {
    return open ? "resolve" : "none";
  }
  return open ? "none" : "open";
};
