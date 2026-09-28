import type {
  CheckKind,
  Inflight,
  MonitorConfig,
  MonitorState,
  ProbeOutcome,
} from "../domain/monitor.ts";
import type { Transition } from "./machine.ts";
import { evaluate } from "./machine.ts";

/** Delay before a failed check is confirmed. */
export const confirmDelayMs = 5000;
/** How long past its timeout an in-flight check is considered lost. */
export const inflightGraceMs = 30_000;

/** A fresh monitor: status unknown, first check due now. */
export const initialState = (now: number): MonitorState => ({
  confirmCounted: false,
  failureStreak: 0,
  inflight: null,
  lastCheckedAt: null,
  lastResult: null,
  manualRequestedAt: null,
  nextCheckAt: now,
  nextCheckKind: "scheduled",
  nextMaintenanceAt: null,
  nextSlotAt: now,
  openIncidentId: null,
  rolledUpThrough: null,
  status: "unknown",
  successStreak: 0,
  summaryRevision: 1,
});

/**
 * The first slot at or after `now` on the grid `anchor + k * interval`
 * (k >= 0). Slots missed while a check or confirm ran are skipped, never
 * run back to back.
 */
export const alignSlot = (
  anchor: number,
  intervalMs: number,
  now: number
): number =>
  anchor >= now
    ? anchor
    : anchor + Math.ceil((now - anchor) / intervalMs) * intervalMs;

export const inflightDeadline = (
  inflight: Inflight,
  config: Pick<MonitorConfig, "timeoutMs">
): number => inflight.startedAt + config.timeoutMs + inflightGraceMs;

/**
 * Clear an in-flight check whose deadline passed (its alarm died mid-probe,
 * or the object was restarted). Returns null when nothing changed.
 */
export const expireInflight = (
  config: MonitorConfig,
  state: MonitorState,
  now: number
): MonitorState | null =>
  state.inflight !== null && now >= inflightDeadline(state.inflight, config)
    ? { ...state, inflight: null }
    : null;

/** Which check is due now, if any. Scheduled slots and confirms go first. */
export const dueCheck = (
  config: MonitorConfig,
  state: MonitorState,
  now: number
): CheckKind | null => {
  if (!config.enabled || state.inflight !== null) {
    return null;
  }
  if (state.nextCheckAt <= now) {
    return state.nextCheckKind;
  }
  return state.manualRequestedAt === null ? null : "manual";
};

/** Record the in-flight check. Must be committed before probing. */
export const startCheck = (
  config: MonitorConfig,
  state: MonitorState,
  kind: CheckKind,
  checkId: string,
  now: number
): { readonly inflight: Inflight; readonly state: MonitorState } => {
  const inflight: Inflight = {
    checkId,
    generation: config.generation,
    kind,
    startedAt: now,
  };
  return { inflight, state: { ...state, inflight } };
};

export interface CheckRecord extends ProbeOutcome {
  readonly at: number;
  readonly checkId: string;
  /** Counts toward uptime: one sample per scheduled slot. */
  readonly counted: boolean;
  readonly kind: CheckKind;
}

export interface IncidentOpen {
  readonly cause: string;
  readonly id: string;
  readonly lastHttpStatus: number | null;
  readonly startedAt: number;
}

export interface IncidentClose {
  readonly id: string;
  readonly resolvedAt: number;
}

export type Completion =
  | { readonly _tag: "Stale" }
  | {
      readonly _tag: "Committed";
      readonly check: CheckRecord;
      readonly closeIncident: IncidentClose | null;
      readonly openIncident: IncidentOpen | null;
      readonly state: MonitorState;
      readonly transition: Transition;
    };

const incidentCause = (outcome: ProbeOutcome): string =>
  outcome.message ?? outcome.errorKind ?? "check failed";

interface Scheduling {
  /** Whether the result counts toward uptime. */
  readonly counted: boolean;
  /** Whether the result is fed to the state machine. */
  readonly fed: boolean;
  readonly state: MonitorState;
}

/**
 * Where the next check goes after a result. A failure that is not itself a
 * confirm schedules a confirm in 5s instead of changing status, unless the
 * monitor is already down (nothing left to confirm).
 */
const schedule = (
  config: MonitorConfig,
  state: MonitorState,
  kind: CheckKind,
  ok: boolean,
  now: number
): Scheduling => {
  const intervalMs = config.intervalSeconds * 1000;
  const confirm = (nextSlotAt: number, confirmCounted: boolean) => ({
    ...state,
    confirmCounted,
    nextCheckAt: now + confirmDelayMs,
    nextCheckKind: "confirm" as const,
    nextSlotAt,
  });
  const scheduled = (slot: number) => ({
    ...state,
    confirmCounted: false,
    nextCheckAt: slot,
    nextCheckKind: "scheduled" as const,
    nextSlotAt: slot,
  });
  const alreadyDown = state.status === "down";

  switch (kind) {
    case "scheduled": {
      const following = alignSlot(
        state.nextCheckAt + intervalMs,
        intervalMs,
        now
      );
      return ok || alreadyDown
        ? { counted: true, fed: true, state: scheduled(following) }
        : { counted: false, fed: false, state: confirm(following, true) };
    }
    case "confirm": {
      return {
        counted: state.confirmCounted,
        fed: true,
        state: scheduled(alignSlot(state.nextSlotAt, intervalMs, now)),
      };
    }
    case "manual": {
      if (ok || alreadyDown) {
        return { counted: false, fed: true, state };
      }
      // A confirm already pending decides; otherwise confirm this failure
      // and keep the upcoming slot.
      return state.nextCheckKind === "confirm"
        ? { counted: false, fed: false, state }
        : {
            counted: false,
            fed: false,
            state: confirm(state.nextCheckAt, false),
          };
    }
    default: {
      return kind satisfies never;
    }
  }
};

/**
 * Commit a probe result. The result is discarded (`Stale`) unless the
 * in-flight record still names this check and the configuration generation
 * did not change while it ran.
 */
export const completeCheck = (
  config: MonitorConfig,
  state: MonitorState,
  inflight: Inflight,
  outcome: ProbeOutcome,
  now: number
): Completion => {
  if (
    state.inflight === null ||
    state.inflight.checkId !== inflight.checkId ||
    inflight.generation !== config.generation
  ) {
    return { _tag: "Stale" };
  }

  const {
    counted,
    fed,
    state: scheduled,
  } = schedule(config, state, inflight.kind, outcome.ok, now);
  const base: MonitorState = {
    ...scheduled,
    inflight: null,
    lastCheckedAt: now,
    lastResult: {
      ...outcome,
      at: now,
      checkId: inflight.checkId,
      kind: inflight.kind,
    },
    // Any request made before this check started is answered by it.
    manualRequestedAt:
      scheduled.manualRequestedAt !== null &&
      scheduled.manualRequestedAt <= inflight.startedAt
        ? null
        : scheduled.manualRequestedAt,
    summaryRevision: state.summaryRevision + 1,
  };
  const check: CheckRecord = {
    ...outcome,
    at: now,
    checkId: inflight.checkId,
    counted,
    kind: inflight.kind,
  };

  if (!fed) {
    return {
      _tag: "Committed",
      check,
      closeIncident: null,
      openIncident: null,
      state: base,
      transition: "none",
    };
  }

  const evaluated = evaluate(base, config, outcome);
  if (evaluated.transition === "down") {
    const openIncident: IncidentOpen = {
      cause: incidentCause(outcome),
      id: inflight.checkId,
      lastHttpStatus: outcome.status,
      startedAt: now,
    };
    return {
      _tag: "Committed",
      check,
      closeIncident: null,
      openIncident,
      state: { ...evaluated.state, openIncidentId: openIncident.id },
      transition: "down",
    };
  }
  if (evaluated.transition === "up" && state.openIncidentId !== null) {
    return {
      _tag: "Committed",
      check,
      closeIncident: { id: state.openIncidentId, resolvedAt: now },
      openIncident: null,
      state: { ...evaluated.state, openIncidentId: null },
      transition: "up",
    };
  }
  return {
    _tag: "Committed",
    check,
    closeIncident: null,
    openIncident: null,
    state: evaluated.state,
    transition: evaluated.transition,
  };
};

/**
 * The alarm time derived from persisted state: the earliest of the next due
 * check (or a pending manual request) when enabled and idle, the in-flight
 * deadline, maintenance, and any `extra` due times later phases add
 * (notification retries, outbox deliveries). Null means no alarm.
 */
export const nextAlarmAt = (
  config: MonitorConfig,
  state: MonitorState,
  extra: readonly (number | null)[] = []
): number | null => {
  const candidates: (number | null)[] = [state.nextMaintenanceAt, ...extra];
  if (state.inflight !== null) {
    candidates.push(inflightDeadline(state.inflight, config));
  } else if (config.enabled) {
    candidates.push(state.nextCheckAt, state.manualRequestedAt);
  }
  const times = candidates.filter((time) => time !== null);
  return times.length === 0 ? null : Math.min(...times);
};
