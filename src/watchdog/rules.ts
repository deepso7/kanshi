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
  /** `reconcile()` had to restore a lost (or late) alarm. */
  readonly alarmRestored: boolean;
  readonly snapshot: MonitorSnapshot | null;
  readonly tombstonedAt: number | null;
}

/** What the watchdog saw of an active monitor, for its episode. */
export interface WatchObservation {
  /**
   * The monitor's alarm was lost and `reconcile()` just restored it, so a
   * stale monitor may already be checked again (see `watchTransition`).
   */
  readonly alarmRestored: boolean;
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

/**
 * Whether a change from `before` to `after` at `now` ends a stale period:
 * a check completing, or the schedule restarting, on a monitor that was
 * stale. Such a change bumps the summary revision (`reviseSummary`) even
 * when no summary field moved, and so is pushed. The watchdog reads each
 * monitor and applies the observations later in one batch; a stale
 * observation read before a reviving change carries the older revision,
 * so the Registry ignores it (`watchOutcome`) instead of opening a false
 * "not being checked" episode. Staleness only grows until such a change,
 * so any monitor read stale is revived by its next check or restart.
 */
export const revives = (
  before: MonitorSnapshot,
  after: MonitorSnapshot,
  now: number
): boolean => isStale(before, now) && !isStale(after, now);

/**
 * Whether re-arming restored a lost alarm: one is due (`at`) but none was
 * set, or the one set was later than due. An earlier alarm is not a loss
 * (it fires and re-arms). `alarmRunning`: the alarm handler is running, so
 * a missing alarm is its own (it re-arms when done), not a lost one.
 */
export const alarmRestored = (
  previous: number | null,
  at: number | null,
  alarmRunning: boolean
): boolean =>
  !alarmRunning && at !== null && (previous === null || previous > at);

export const observe = (
  snapshot: MonitorSnapshot,
  now: number,
  restored: boolean
): WatchObservation => ({
  alarmRestored: restored,
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
        observation: observe(status.snapshot, now, status.alarmRestored),
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
 * - `suspect`: would open, but the observation came from the batch, so
 *   nothing is recorded; the runner re-reads the monitor and opens only if
 *   the fresh read confirms it (`confirmSuspect`, `Registry.confirmStale`).
 */
export type WatchChange = "close" | "none" | "open" | "resolve" | "suspect";

/**
 * One watchdog observation's effect on the monitor's episode. A single
 * stale observation opens one (the run is hourly, and the threshold is
 * already several intervals); it stays open, with no further alert, until
 * an observation finds the monitor checked again or disabled.
 *
 * A stale monitor whose lost alarm this run restored changes nothing: the
 * restored alarm is due at once, so it is likely checked again before the
 * batch is applied, and alerting it would be a false alarm followed by a
 * recovery. If the restored alarm did not bring checks back, the next run
 * finds it stale with its alarm in place and opens the episode then (so a
 * lost alarm alerts about an hour later than a wedged monitor).
 */
export const watchTransition = (
  previous: WatchState,
  observation: Pick<WatchObservation, "alarmRestored" | "enabled" | "stale">
): WatchChange => {
  const open = previous.episodeId !== null;
  if (!observation.enabled) {
    return open ? "close" : "none";
  }
  if (!observation.stale) {
    return open ? "resolve" : "none";
  }
  if (observation.alarmRestored) {
    return "none";
  }
  return open ? "none" : "open";
};

/** The Registry row an observation is applied to, as stored. */
export interface WatchedRow {
  readonly episodeId: string | null;
  readonly lifecycle: WatchdogRow["lifecycle"];
  readonly summaryRevision: number;
}

/** What applying one `ReconcileItem`'s observation does to its episode. */
export interface WatchOutcome {
  /** False when the observation is out of date (nothing recorded). */
  readonly applied: boolean;
  readonly change: WatchChange;
}

/**
 * Apply an observation only while it is current. The watchdog reads the
 * monitor, then applies the whole batch later, so by then the row may be
 * gone, `deleting`, or carry a newer summary revision than the observation
 * (a disable, edit or status change pushed in between, or a check that
 * revived the stale monitor, see `revives`); such an observation is
 * ignored, and the next run decides on a fresh one. An
 * equal or older stored revision means the observation is at least as new
 * as anything the Registry knows (the caller stores its summary first).
 *
 * Only a `confirmed` observation opens an episode. The batch's (not
 * confirmed) would-be opens come back as `suspect`: the Registry cannot
 * see a check or disable the Monitor committed but has not pushed yet, so
 * the runner re-reads the monitor itself after the batch
 * (`confirmSuspect`) and sends the fresh observation back confirmed.
 * Resolves and closes apply from the batch: a stale read cannot make them
 * wrong (at worst they come an hour late).
 */
export const watchOutcome = (
  row: WatchedRow | null,
  item: Pick<ReconcileItem, "observation" | "revision">,
  confirmed: boolean
): WatchOutcome => {
  if (
    row === null ||
    row.lifecycle !== "active" ||
    row.summaryRevision > item.revision
  ) {
    return { applied: false, change: "none" };
  }
  const change = watchTransition(
    { episodeId: row.episodeId },
    item.observation
  );
  return {
    applied: true,
    change: change === "open" && !confirmed ? "suspect" : change,
  };
};

/**
 * The confirming observation of a `suspect`, from the monitor's own state
 * read after the batch (`status()`), or null when it no longer warrants an
 * episode: unreadable, deleted or unconfigured, no longer stale (a check
 * completed, or its schedule restarted by an enable or a probe-affecting
 * edit), or disabled (never stale). The Monitor's storage is read
 * directly, so a change it committed but has not pushed yet counts.
 *
 * The decision rests on the fresh read's own staleness, not on its summary
 * revision matching the batch's read: every change that could end the
 * episode's cause ends staleness itself, while a cosmetic edit (name, URL)
 * moves the revision without restarting checks, and the monitor is still
 * stuck. The confirming item carries the fresh read's revision, so the
 * Registry opens only if it stores nothing newer than that read
 * (`watchOutcome`). Nothing is restored by this read, so `alarmRestored`
 * is false.
 */
export const confirmSuspect = (
  suspect: ReconcileItem,
  status: Pick<WatchdogStatus, "snapshot" | "tombstonedAt"> | null,
  now: number
): ReconcileItem | null => {
  if (
    status === null ||
    status.tombstonedAt !== null ||
    status.snapshot === null
  ) {
    return null;
  }
  const { snapshot } = status;
  if (!isStale(snapshot, now)) {
    return null;
  }
  return {
    id: suspect.id,
    observation: observe(snapshot, now, false),
    revision: snapshot.state.summaryRevision,
    summary: summaryOf(snapshot.config, snapshot.state),
  };
};
