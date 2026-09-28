import { probeAffectingFields } from "../domain/monitor-input.ts";
import type {
  IncidentResolution,
  MonitorConfig,
  MonitorState,
} from "../domain/monitor.ts";
import type { IncidentClose } from "./cycle.ts";

export interface ConfigChange {
  readonly closeIncident:
    | (IncidentClose & { readonly resolution: IncidentResolution })
    | null;
  readonly config: MonitorConfig;
  readonly state: MonitorState;
}

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const isProbeAffecting = (
  before: MonitorConfig,
  after: MonitorConfig
): boolean =>
  probeAffectingFields.some((field) => !sameValue(before[field], after[field]));

/**
 * Clears the in-flight check and any pending confirm; next check now. Stamps
 * `scheduleResetAt`, which the watchdog measures staleness from.
 */
const restartChecks = (state: MonitorState, now: number): MonitorState => ({
  ...state,
  confirmCounted: false,
  failureStreak: 0,
  inflight: null,
  nextCheckAt: now,
  nextCheckKind: "scheduled",
  nextSlotAt: now,
  scheduleResetAt: now,
  successStreak: 0,
});

/**
 * Reset rules for a configuration edit (`after` is `before` with the patch
 * applied, same generation):
 *
 * - Disable: bump generation, status unknown, streaks reset, in-flight and
 *   pending confirm and manual request cleared, open incident closed as
 *   `disabled` (no alert).
 * - Enable: bump generation, status unknown, streaks reset, check now. A
 *   still-down target therefore opens a new incident.
 * - Probe-affecting edit: bump generation, streaks reset, in-flight and
 *   pending confirm cleared, check now. Status is kept.
 * - Anything else (name, channels, managed): no reset.
 */
export const applyConfigChange = (
  before: MonitorConfig,
  after: MonitorConfig,
  state: MonitorState,
  now: number
): ConfigChange => {
  const changed = !sameValue(before, after);
  const bumped = {
    ...state,
    summaryRevision: state.summaryRevision + (changed ? 1 : 0),
  };
  const nextGeneration = { ...after, generation: before.generation + 1 };

  if (before.enabled && !after.enabled) {
    return {
      closeIncident:
        state.openIncidentId === null
          ? null
          : {
              id: state.openIncidentId,
              resolution: "disabled",
              resolvedAt: now,
            },
      config: nextGeneration,
      state: {
        ...restartChecks(bumped, now),
        manualRequestedAt: null,
        openIncidentId: null,
        status: "unknown",
      },
    };
  }
  if (!before.enabled && after.enabled) {
    return {
      closeIncident: null,
      config: nextGeneration,
      state: { ...restartChecks(bumped, now), status: "unknown" },
    };
  }
  if (isProbeAffecting(before, after)) {
    return {
      closeIncident: null,
      config: nextGeneration,
      state: restartChecks(bumped, now),
    };
  }
  return { closeIncident: null, config: after, state: bumped };
};
