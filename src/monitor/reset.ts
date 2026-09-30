import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { probeAffectingFields } from "../domain/monitor-input.ts";
import type { IncidentResolution, MonitorState } from "../domain/monitor.ts";
import { MonitorConfig, reviseSummary } from "../domain/monitor.ts";
import { revives } from "../watchdog/rules.ts";
import type { IncidentClose } from "./cycle.ts";

export interface ConfigChange {
  readonly closeIncident:
    | (IncidentClose & { readonly resolution: IncidentResolution })
    | null;
  readonly config: MonitorConfig;
  readonly state: MonitorState;
}

/** Structural equality over the probe-affecting fields only. */
const sameProbe = Schema.toEquivalence(
  MonitorConfig.mapFields(Struct.pick(probeAffectingFields))
);

export const isProbeAffecting = (
  before: MonitorConfig,
  after: MonitorConfig
): boolean => !sameProbe(before, after);

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

const resetFor = (
  before: MonitorConfig,
  after: MonitorConfig,
  state: MonitorState,
  now: number
): ConfigChange => {
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
        ...restartChecks(state, now),
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
      state: { ...restartChecks(state, now), status: "unknown" },
    };
  }
  if (isProbeAffecting(before, after)) {
    return {
      closeIncident: null,
      config: nextGeneration,
      state: restartChecks(state, now),
    };
  }
  return { closeIncident: null, config: after, state };
};

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
 * - Anything else (name, channels): no reset.
 */
export const applyConfigChange = (
  before: MonitorConfig,
  after: MonitorConfig,
  state: MonitorState,
  now: number
): ConfigChange => {
  const change = resetFor(before, after, state, now);
  // The summary revision moves only if the Registry-visible summary did,
  // or the edit restarted the schedule of a stale monitor (`revives`).
  const changed = { config: change.config, state: change.state };
  return {
    ...change,
    state: reviseSummary(
      { config: before, state },
      changed,
      revives({ config: before, state }, changed, now)
    ),
  };
};
