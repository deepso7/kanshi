import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AlertMessage,
  alertRequest,
  alertText,
  idempotencyKey,
  webhookPayload,
} from "../../src/alerts/message.ts";
import type {
  MonitorConfig,
  MonitorSnapshot,
  ProbeOutcome,
} from "../../src/domain/monitor.ts";
import { shouldPushSummary, summaryOf } from "../../src/domain/monitor.ts";
import {
  Completion,
  completeCheck,
  initialState,
  nextAlarmAt,
  startCheck,
} from "../../src/monitor/cycle.ts";
import { applyConfigChange } from "../../src/monitor/reset.ts";
import type {
  ReconcileReport,
  RegistryEntry,
} from "../../src/registry/registry.ts";
import type {
  ReconcileItem,
  WatchdogRow,
  WatchdogStatus,
  WatchedRow,
  WatchState,
} from "../../src/watchdog/rules.ts";
import {
  alarmRestored,
  confirmSuspect,
  creatingGraceMs,
  decide,
  isStale,
  lastSignOfLife,
  needsReconcile,
  revives,
  staleFloorMs,
  staleThresholdMs,
  WatchdogAction,
  watchOutcome,
  watchTransition,
} from "../../src/watchdog/rules.ts";
import type { WatchdogDeps } from "../../src/watchdog/run.ts";
import { runWatchdog } from "../../src/watchdog/run.ts";

const minute = 60_000;
const t0 = 1_700_000_000_000;

const config: MonitorConfig = {
  bodyContains: null,
  channels: "all",
  createdAt: t0,
  enabled: true,
  expectedStatus: "2xx",
  failureThreshold: 1,
  generation: 0,
  id: "m1",
  intervalSeconds: 60,
  method: "GET",
  name: "Site",
  successThreshold: 1,
  timeoutMs: 10_000,
  updatedAt: t0,
  url: "https://example.com/",
};

const snapshot = (
  overrides: {
    readonly config?: Partial<MonitorConfig>;
    readonly lastCheckedAt?: number | null;
    readonly scheduleResetAt?: number;
    readonly summaryRevision?: number;
  } = {}
): MonitorSnapshot => ({
  config: { ...config, ...overrides.config },
  state: {
    ...initialState(t0),
    lastCheckedAt: overrides.lastCheckedAt ?? null,
    scheduleResetAt: overrides.scheduleResetAt ?? t0,
    status: "up",
    summaryRevision: overrides.summaryRevision ?? 7,
  },
});

const row = (overrides: Partial<WatchdogRow> = {}): WatchdogRow => ({
  createdAt: t0,
  lifecycle: "active",
  opId: "op1",
  ...overrides,
});

const live = (value: MonitorSnapshot = snapshot()): WatchdogStatus => ({
  alarmRestored: false,
  snapshot: value,
  tombstonedAt: null,
});
const unconfigured: WatchdogStatus = {
  alarmRestored: false,
  snapshot: null,
  tombstonedAt: null,
};
const tombstoned: WatchdogStatus = {
  alarmRestored: false,
  snapshot: null,
  tombstonedAt: t0,
};

describe("watchdog decisions", () => {
  it("leaves a young creating row alone and needs no status for it", () => {
    const young = row({ lifecycle: "creating" });
    const now = t0 + creatingGraceMs - 1;
    assert.isFalse(needsReconcile(young, now));
    assert.deepStrictEqual(decide(young, null, now), WatchdogAction.Wait());
  });

  it("activates a stuck create whose monitor was configured", () => {
    const stuck = row({ lifecycle: "creating", opId: "op9" });
    const now = t0 + creatingGraceMs;
    assert.isTrue(needsReconcile(stuck, now));
    assert.deepStrictEqual(
      decide(stuck, live(), now),
      WatchdogAction.Activate({ opId: "op9" })
    );
  });

  it("abandons a stuck create whose monitor is unconfigured or tombstoned", () => {
    const stuck = row({ lifecycle: "creating", opId: "op9" });
    const now = t0 + 10 * minute;
    for (const status of [unconfigured, tombstoned]) {
      assert.deepStrictEqual(
        decide(stuck, status, now),
        WatchdogAction.Abandon({ opId: "op9" })
      );
    }
    // A tombstone wins even if a snapshot were somehow reported.
    assert.deepStrictEqual(
      decide(
        stuck,
        { alarmRestored: false, snapshot: snapshot(), tombstonedAt: t0 },
        now
      ),
      WatchdogAction.Abandon({ opId: "op9" })
    );
  });

  it("skips a stuck create when its status could not be fetched", () => {
    const stuck = row({ lifecycle: "creating" });
    assert.strictEqual(decide(stuck, null, t0 + 10 * minute)._tag, "Skip");
  });

  it("retries a stuck delete whatever its age, without a status", () => {
    const deleting = row({ lifecycle: "deleting" });
    assert.isFalse(needsReconcile(deleting, t0));
    assert.deepStrictEqual(
      decide(deleting, null, t0),
      WatchdogAction.Destroy()
    );
  });

  it("refreshes an active monitor with its summary and revision", () => {
    const now = t0 + minute;
    const value = snapshot({ lastCheckedAt: t0 + 30_000, summaryRevision: 12 });
    assert.isTrue(needsReconcile(row(), t0));
    assert.deepStrictEqual(
      decide(row(), live(value), now),
      WatchdogAction.Refresh({
        observation: {
          alarmRestored: false,
          enabled: true,
          intervalSeconds: 60,
          lastCheckedAt: t0 + 30_000,
          name: "Site",
          stale: false,
          url: "https://example.com/",
        },
        revision: 12,
        summary: {
          enabled: true,
          intervalSeconds: 60,
          name: "Site",
          status: "up",
          url: "https://example.com/",
        },
      })
    );
  });

  it("refreshes disabled monitors too, which are never stale", () => {
    const value = snapshot({ config: { enabled: false } });
    const action = decide(row(), live(value), t0 + 365 * 24 * 60 * minute);
    assert.strictEqual(action._tag, "Refresh");
    if (WatchdogAction.$is("Refresh")(action)) {
      assert.isFalse(action.summary.enabled);
      assert.isFalse(action.observation.stale);
    }
  });

  it("skips an active row whose monitor is missing or deleted", () => {
    for (const status of [unconfigured, tombstoned, null]) {
      assert.strictEqual(decide(row(), status, t0)._tag, "Skip");
    }
  });
});

describe("staleness", () => {
  it("allows two intervals plus two minutes, and at least the floor", () => {
    assert.strictEqual(staleFloorMs, 10 * minute);
    assert.strictEqual(staleThresholdMs(60), 10 * minute);
    assert.strictEqual(staleThresholdMs(5), 10 * minute);
    assert.strictEqual(staleThresholdMs(300), 12 * minute);
    assert.strictEqual(staleThresholdMs(3600), 122 * minute);
  });

  it("measures from the last check, creation or schedule reset, whichever is latest", () => {
    assert.strictEqual(lastSignOfLife(snapshot()), t0);
    assert.strictEqual(
      lastSignOfLife(snapshot({ lastCheckedAt: t0 + minute })),
      t0 + minute
    );
    assert.strictEqual(
      lastSignOfLife(
        snapshot({
          lastCheckedAt: t0 + minute,
          scheduleResetAt: t0 + 5 * minute,
        })
      ),
      t0 + 5 * minute
    );
    // `updatedAt` alone (a cosmetic edit) is not a sign of life.
    assert.strictEqual(
      lastSignOfLife(
        snapshot({
          config: { updatedAt: t0 + 5 * minute },
          lastCheckedAt: t0 + minute,
        })
      ),
      t0 + minute
    );
  });

  describe("edits of an already-stale monitor", () => {
    // Last checked at t0, stale since t0 + 10 minutes; edited at t0 + 20.
    const stale = snapshot({ lastCheckedAt: t0 });
    const editedAt = t0 + 20 * minute;
    const edit = (patch: Partial<MonitorConfig>) => {
      const after = { ...stale.config, ...patch, updatedAt: editedAt };
      const change = applyConfigChange(
        stale.config,
        after,
        stale.state,
        editedAt
      );
      return { config: change.config, state: change.state };
    };

    it("stays stale after a cosmetic edit", () => {
      assert.isTrue(isStale(stale, editedAt));
      for (const patch of [
        { name: "Renamed" },
        { channels: ["c1"] },
      ] satisfies readonly Partial<MonitorConfig>[]) {
        const edited = edit(patch);
        assert.strictEqual(edited.config.updatedAt, editedAt);
        assert.isTrue(isStale(edited, editedAt + 1), JSON.stringify(patch));
      }
    });

    it("restarts the clock on a probe-affecting edit", () => {
      const edited = edit({ timeoutMs: 5000 });
      assert.strictEqual(lastSignOfLife(edited), editedAt);
      assert.isFalse(isStale(edited, editedAt + 10 * minute));
      assert.isTrue(isStale(edited, editedAt + 10 * minute + 1));
    });

    it("restarts the clock on enable", () => {
      const disabledAt = t0 + 5 * minute;
      const disabled = applyConfigChange(
        stale.config,
        { ...stale.config, enabled: false, updatedAt: disabledAt },
        stale.state,
        disabledAt
      );
      const enabled = applyConfigChange(
        disabled.config,
        { ...disabled.config, enabled: true, updatedAt: editedAt },
        disabled.state,
        editedAt
      );
      const value = { config: enabled.config, state: enabled.state };
      assert.strictEqual(lastSignOfLife(value), editedAt);
      assert.isFalse(isStale(value, editedAt + 10 * minute));
    });
  });

  it("is stale only strictly past the threshold, and only when enabled", () => {
    const value = snapshot({ lastCheckedAt: t0 });
    assert.isFalse(isStale(value, t0 + 10 * minute));
    assert.isTrue(isStale(value, t0 + 10 * minute + 1));
    const disabled = snapshot({
      config: { enabled: false },
      lastCheckedAt: t0,
    });
    assert.isFalse(isStale(disabled, t0 + 60 * minute));
  });

  it("counts a never-checked monitor from its creation", () => {
    assert.isFalse(isStale(snapshot(), t0 + 10 * minute));
    assert.isTrue(isStale(snapshot(), t0 + 11 * minute));
  });
});

describe("episodes and dedup", () => {
  const fresh = { alarmRestored: false, enabled: true, stale: false };
  const stale = { alarmRestored: false, enabled: true, stale: true };
  const disabled = { alarmRestored: false, enabled: false, stale: false };
  /** Stale, but this run's `reconcile()` restored its lost alarm. */
  const restored = { alarmRestored: true, enabled: true, stale: true };

  /** Run the transition over observations, starting with no episode. */
  const run = (observations: readonly (typeof fresh)[]) => {
    let state: WatchState = { episodeId: null };
    const changes: string[] = [];
    for (const observation of observations) {
      const change = watchTransition(state, observation);
      changes.push(change);
      if (change === "open") {
        state = { episodeId: "ep" };
      } else if (change !== "none") {
        state = { episodeId: null };
      }
    }
    return { changes, state };
  };

  it("opens an episode on a single stale observation", () => {
    assert.deepStrictEqual(run([stale]).changes, ["open"]);
    assert.deepStrictEqual(run([fresh, stale]).changes, ["none", "open"]);
  });

  it("alerts once per episode, however long it lasts", () => {
    const result = run([stale, stale, stale, stale]);
    assert.deepStrictEqual(result.changes, ["open", "none", "none", "none"]);
    assert.strictEqual(result.state.episodeId, "ep");
  });

  it("resolves when checks resume, and can alert again later", () => {
    assert.deepStrictEqual(run([stale, fresh, fresh, stale]).changes, [
      "open",
      "resolve",
      "none",
      "open",
    ]);
  });

  it("closes silently when the monitor is disabled", () => {
    const result = run([stale, disabled]);
    assert.deepStrictEqual(result.changes, ["open", "close"]);
    assert.deepStrictEqual(result.state, { episodeId: null });
    assert.deepStrictEqual(run([disabled, disabled]).changes, ["none", "none"]);
  });

  it("waits a run before alerting a monitor whose lost alarm it restored", () => {
    // Checks resumed on the restored alarm: never alerted.
    assert.deepStrictEqual(run([restored, fresh]).changes, ["none", "none"]);
    // Still stale with its alarm in place: alerted on the next run.
    assert.deepStrictEqual(run([restored, stale]).changes, ["none", "open"]);
    // An open episode is neither resolved nor re-alerted by a restore.
    const result = run([stale, restored]);
    assert.deepStrictEqual(result.changes, ["open", "none"]);
    assert.strictEqual(result.state.episodeId, "ep");
    // Not stale despite the restore: the episode resolves as usual.
    assert.deepStrictEqual(
      run([stale, { ...restored, stale: false }]).changes,
      ["open", "resolve"]
    );
  });
});

describe(alarmRestored, () => {
  it("counts a missing or late alarm as restored", () => {
    assert.isTrue(alarmRestored(null, t0, false));
    assert.isTrue(alarmRestored(t0 + minute, t0, false));
  });

  it("does not count an alarm that was already due, or none needed", () => {
    assert.isFalse(alarmRestored(t0, t0, false));
    assert.isFalse(alarmRestored(t0 - minute, t0, false));
    assert.isFalse(alarmRestored(null, null, false));
  });

  it("does not count the running alarm handler's own missing alarm", () => {
    assert.isFalse(alarmRestored(null, t0, true));
  });
});

const watched = (overrides: Partial<WatchedRow> = {}): WatchedRow => ({
  episodeId: null,
  lifecycle: "active",
  summaryRevision: 5,
  ...overrides,
});

describe(watchOutcome, () => {
  const stale: ReconcileItem["observation"] = {
    alarmRestored: false,
    enabled: true,
    intervalSeconds: 60,
    lastCheckedAt: t0,
    name: "Site",
    stale: true,
    url: "https://example.com/",
  };

  it("only reports a batch observation that would open as a suspect", () => {
    assert.deepStrictEqual(
      watchOutcome(watched(), { observation: stale, revision: 5 }, false),
      { applied: true, change: "suspect" }
    );
    // Resolves and closes apply from the batch.
    const open = watched({ episodeId: "ep" });
    assert.deepStrictEqual(
      watchOutcome(
        open,
        { observation: { ...stale, stale: false }, revision: 5 },
        false
      ),
      { applied: true, change: "resolve" }
    );
    assert.deepStrictEqual(
      watchOutcome(
        open,
        { observation: { ...stale, enabled: false }, revision: 5 },
        false
      ),
      { applied: true, change: "close" }
    );
    // Already open: deduplicated, not a suspect.
    assert.deepStrictEqual(
      watchOutcome(open, { observation: stale, revision: 5 }, false),
      { applied: true, change: "none" }
    );
  });

  it("opens an episode for a confirmed stale observation", () => {
    assert.deepStrictEqual(
      watchOutcome(watched(), { observation: stale, revision: 5 }, true),
      { applied: true, change: "open" }
    );
  });

  it("ignores a stale observation superseded by a newer revision", () => {
    // Read at revision 5; a status change was pushed as 6 before the batch.
    assert.deepStrictEqual(
      watchOutcome(
        watched({ summaryRevision: 6 }),
        { observation: stale, revision: 5 },
        true
      ),
      { applied: false, change: "none" }
    );
  });

  it("ignores an observation taken before a disable", () => {
    // The monitor was read enabled and stale at revision 5, then disabled
    // (revision 6, pushed) before the batch was applied.
    const disabledSince = watched({ summaryRevision: 6 });
    assert.deepStrictEqual(
      watchOutcome(disabledSince, { observation: stale, revision: 5 }, true),
      { applied: false, change: "none" }
    );
    // An open episode is left for the next run too (which closes it).
    assert.deepStrictEqual(
      watchOutcome(
        { ...disabledSince, episodeId: "ep" },
        { observation: { ...stale, stale: false }, revision: 5 },
        false
      ),
      { applied: false, change: "none" }
    );
  });

  it("ignores a row that is gone or no longer active", () => {
    const item = { observation: stale, revision: 5 };
    assert.isFalse(watchOutcome(null, item, true).applied);
    assert.isFalse(
      watchOutcome(watched({ lifecycle: "deleting" }), item, true).applied
    );
  });

  it("applies an observation newer than a lost push", () => {
    // The Registry missed revision 5 (stored 3); the item carries it.
    assert.deepStrictEqual(
      watchOutcome(
        watched({ summaryRevision: 3 }),
        { observation: stale, revision: 5 },
        true
      ),
      { applied: true, change: "open" }
    );
  });
});

/** A probe-affecting edit that leaves the summary alone: its revision. */
const editTimeout = (value: MonitorSnapshot, at: number): number =>
  applyConfigChange(
    value.config,
    { ...value.config, timeoutMs: 5000, updatedAt: at },
    value.state,
    at
  ).state.summaryRevision;

describe("checks between the watchdog's read and its batch", () => {
  const up: ProbeOutcome = {
    errorKind: null,
    latencyMs: 12,
    message: null,
    ok: true,
    status: 200,
  };
  // Up, last checked at t0, its next check overdue since t0 + 1 minute
  // with the alarm in place (nothing restored): stale at t0 + 30 minutes.
  const stuck: MonitorSnapshot = {
    config,
    state: {
      ...snapshot({ lastCheckedAt: t0, summaryRevision: 5 }).state,
      nextCheckAt: t0 + minute,
      nextSlotAt: t0 + minute,
    },
  };
  const readAt = t0 + 30 * minute;

  /** The watchdog's read of `value`: its batch item. */
  const read = (value: MonitorSnapshot, at = readAt) => {
    const action = decide(row(), live(value), at);
    if (!WatchdogAction.$is("Refresh")(action)) {
      throw new Error("expected a refresh");
    }
    return { observation: action.observation, revision: action.revision };
  };

  /** A same-status check of `value` finishing at `at`. */
  const check = (value: MonitorSnapshot, at: number) => {
    const started = startCheck(value.config, value.state, "scheduled", "c", at);
    const completion = completeCheck(
      value.config,
      started.state,
      started.inflight,
      up,
      at + 100
    );
    if (!Completion.$is("Committed")(completion)) {
      throw new Error("expected a committed check");
    }
    return { config: value.config, state: completion.state };
  };

  it("does not alert when a same-status check completes before the batch", () => {
    const item = read(stuck);
    assert.isTrue(item.observation.stale);
    assert.isFalse(item.observation.alarmRestored);
    // The overdue alarm fires right after the read; the check keeps the
    // status (up) but revives the monitor, so it bumps and pushes.
    const after = check(stuck, readAt + 1000);
    assert.strictEqual(after.state.status, "up");
    assert.strictEqual(after.state.summaryRevision, 6);
    assert.isTrue(shouldPushSummary(stuck, after));
    // The batch finds the pushed revision newer than its read: ignored.
    assert.deepStrictEqual(
      watchOutcome(watched({ summaryRevision: 6 }), item, false),
      { applied: false, change: "none" }
    );
    // The next run (checks kept going) reads it fresh at that revision.
    const later = {
      ...after,
      state: { ...after.state, lastCheckedAt: readAt + 55 * minute },
    };
    assert.deepStrictEqual(
      watchOutcome(
        watched({ summaryRevision: 6 }),
        read(later, readAt + 60 * minute),
        false
      ),
      { applied: true, change: "none" }
    );
  });

  it("still alerts a monitor that stays stuck", () => {
    const item = read(stuck);
    // Its alarm is armed and already due, like every stale monitor's (the
    // next check only moves when one completes), so "armed and due soon"
    // cannot tell it apart from one about to be checked.
    assert.isAtMost(nextAlarmAt(stuck.config, stuck.state) ?? 0, readAt);
    // No check completes: the Registry still has the read revision, so
    // the batch reports a suspect, and the re-read after it confirms.
    assert.deepStrictEqual(watchOutcome(watched(), item, false), {
      applied: true,
      change: "suspect",
    });
    const confirmed = confirmSuspect(
      { ...item, id: "m1", summary: summaryOf(stuck.config, stuck.state) },
      live(stuck),
      readAt + 2000
    );
    assert.isNotNull(confirmed);
    assert.isTrue(confirmed?.observation.stale);
    assert.strictEqual(confirmed?.revision, 5);
    assert.deepStrictEqual(watchOutcome(watched(), confirmed ?? item, true), {
      applied: true,
      change: "open",
    });
  });

  describe("confirming a suspect with a read after the batch", () => {
    const suspect = {
      ...read(stuck),
      id: "m1",
      summary: summaryOf(stuck.config, stuck.state),
    };
    // The batch is applied at readAt + 1s: stale, no newer revision known.
    const batchAt = readAt + 1000;
    const confirmAt = readAt + 2000;

    it("opens nothing for a check committed but not yet pushed", () => {
      // The overdue alarm's check commits right after the first read; its
      // push has not reached the Registry when the batch is applied.
      const after = check(stuck, readAt + 500);
      assert.strictEqual(after.state.summaryRevision, 6);
      assert.deepStrictEqual(watchOutcome(watched(), suspect, false), {
        applied: true,
        change: "suspect",
      });
      // The re-read sees the Monitor's own state: checked, so not stale.
      assert.isNull(confirmSuspect(suspect, live(after), confirmAt));
    });

    it("opens nothing for a schedule reset after the first read", () => {
      // A probe-affecting edit, or an enable, restarts checks: not stale,
      // whether or not its revision moved.
      for (const patch of [
        { timeoutMs: 5000 },
        { url: "https://example.org/" },
      ] satisfies readonly Partial<MonitorConfig>[]) {
        const edited = applyConfigChange(
          stuck.config,
          { ...stuck.config, ...patch, updatedAt: batchAt },
          stuck.state,
          batchAt
        );
        const after = { config: edited.config, state: edited.state };
        assert.strictEqual(after.state.scheduleResetAt, batchAt);
        assert.isNull(
          confirmSuspect(suspect, live(after), confirmAt),
          JSON.stringify(patch)
        );
      }
    });

    it("still opens a monitor renamed after the first read", () => {
      // A cosmetic edit commits between the batch and the re-read: the
      // revision moves (the name is in the summary) but checks do not
      // restart, so the monitor is still stuck.
      const renamed = applyConfigChange(
        stuck.config,
        { ...stuck.config, name: "Renamed", updatedAt: batchAt },
        stuck.state,
        batchAt
      );
      const after = { config: renamed.config, state: renamed.state };
      assert.strictEqual(after.state.summaryRevision, 6);
      assert.strictEqual(
        after.state.scheduleResetAt,
        stuck.state.scheduleResetAt
      );
      const confirmed = confirmSuspect(suspect, live(after), confirmAt);
      assert.isNotNull(confirmed);
      // The confirming item is the fresh read: its revision and name.
      assert.strictEqual(confirmed?.revision, 6);
      assert.strictEqual(confirmed?.observation.name, "Renamed");
      assert.isTrue(confirmed?.observation.stale);
      // The Registry opens it whether the rename's push has landed or not,
      // and not if a revision newer than the fresh read is stored.
      for (const summaryRevision of [5, 6]) {
        assert.deepStrictEqual(
          watchOutcome(
            watched({ summaryRevision }),
            confirmed ?? suspect,
            true
          ),
          { applied: true, change: "open" }
        );
      }
      assert.deepStrictEqual(
        watchOutcome(
          watched({ summaryRevision: 7 }),
          confirmed ?? suspect,
          true
        ),
        { applied: false, change: "none" }
      );
    });

    it("opens nothing for a monitor disabled after the first read", () => {
      const disabled = applyConfigChange(
        stuck.config,
        { ...stuck.config, enabled: false, updatedAt: batchAt },
        stuck.state,
        batchAt
      );
      const after = { config: disabled.config, state: disabled.state };
      assert.isAbove(after.state.summaryRevision, suspect.revision);
      assert.isNull(confirmSuspect(suspect, live(after), confirmAt));
      // Disabled is never stale, whatever the revision.
      assert.isNull(
        confirmSuspect(
          { ...suspect, revision: after.state.summaryRevision },
          live(after),
          confirmAt
        )
      );
    });

    it("opens nothing for a monitor deleted or unreadable", () => {
      assert.isNull(confirmSuspect(suspect, tombstoned, confirmAt));
      assert.isNull(confirmSuspect(suspect, unconfigured, confirmAt));
      assert.isNull(confirmSuspect(suspect, null, confirmAt));
    });

    it("opens a monitor still stale at the same revision", () => {
      const confirmed = confirmSuspect(suspect, live(stuck), confirmAt);
      assert.deepStrictEqual(confirmed, {
        ...suspect,
        observation: { ...suspect.observation, alarmRestored: false },
      });
      assert.deepStrictEqual(
        watchOutcome(watched(), confirmed ?? suspect, true),
        { applied: true, change: "open" }
      );
      // A newer revision pushed before the confirming write still wins.
      assert.deepStrictEqual(
        watchOutcome(
          watched({ summaryRevision: 6 }),
          confirmed ?? suspect,
          true
        ),
        { applied: false, change: "none" }
      );
    });
  });

  it("does not bump the revision for a same-status check of a fresh monitor", () => {
    const fresh = check(stuck, t0 + 5 * minute);
    assert.strictEqual(fresh.state.summaryRevision, 5);
    assert.isFalse(shouldPushSummary(stuck, fresh));
    // The first check after a gap bumps once; the next one does not.
    const revived = check(stuck, readAt);
    const following = check(revived, readAt + minute);
    assert.strictEqual(revived.state.summaryRevision, 6);
    assert.strictEqual(following.state.summaryRevision, 6);
  });

  it("bumps the revision when an edit restarts a stale monitor's schedule", () => {
    // A timeout edit is probe-affecting but not in the summary.
    assert.strictEqual(editTimeout(stuck, readAt), 6);
    assert.strictEqual(editTimeout(stuck, t0 + 5 * minute), 5);
  });

  describe(revives, () => {
    it("is true only when a stale monitor stops being stale", () => {
      const checked = {
        ...stuck,
        state: { ...stuck.state, lastCheckedAt: readAt },
      };
      assert.isTrue(revives(stuck, checked, readAt));
      // Not stale before, or still stale after.
      assert.isFalse(revives(stuck, checked, t0 + 5 * minute));
      assert.isFalse(revives(stuck, stuck, readAt));
      // A disabled monitor is never stale, so enabling it revives nothing.
      const disabled = { ...stuck, config: { ...config, enabled: false } };
      assert.isFalse(revives(disabled, checked, readAt));
    });
  });
});

const ChatBody = Schema.fromJsonString(Schema.Struct({ text: Schema.String }));
const DiscordBody = Schema.fromJsonString(
  Schema.Struct({
    allowed_mentions: Schema.Struct({ parse: Schema.Array(Schema.String) }),
    content: Schema.optionalKey(Schema.String),
    embeds: Schema.Array(
      Schema.Struct({ color: Schema.Number, title: Schema.String })
    ),
  })
);

describe("not-being-checked messages", () => {
  const episode = {
    id: "watchdog-1",
    intervalSeconds: 300,
    lastCheckedAt: t0,
    resolvedAt: null,
    startedAt: t0 + 15 * minute,
  };
  const monitor = { id: "m1", name: "Site", url: "https://example.com/" };
  const notCheckedAlert = {
    episode,
    idempotencyKey: idempotencyKey("watchdog-1", "down", "c1"),
    monitor,
    sentAt: t0 + 16 * minute,
  };
  const notChecked = AlertMessage.NotChecked(notCheckedAlert);
  const resolvedEpisode = { ...episode, resolvedAt: t0 + 40 * minute };

  it("says the monitor is not being checked, then checked again", () => {
    assert.deepStrictEqual(alertText(notChecked), {
      body: "Last check: 16m ago (expected every 5m)\nhttps://example.com/",
      title: "monitor Site is not being checked",
    });
    assert.strictEqual(
      alertText(
        AlertMessage.NotChecked({
          ...notCheckedAlert,
          episode: { ...episode, lastCheckedAt: null },
        })
      ).body.split("\n")[0],
      "Last check: never (expected every 5m)"
    );
    assert.strictEqual(
      alertText(
        AlertMessage.CheckedAgain({
          ...notCheckedAlert,
          episode: resolvedEpisode,
        })
      ).title,
      "monitor Site is being checked again after 40m"
    );
    assert.strictEqual(
      alertText(
        AlertMessage.NotCheckedResolved({
          ...notCheckedAlert,
          episode: resolvedEpisode,
        })
      ).title,
      "monitor Site was not checked for 40m, checks resumed"
    );
  });

  it("formats chat messages without a brand or a mention", () => {
    const slack = alertRequest(
      "slack",
      "https://hooks.slack.com/x",
      notChecked
    );
    assert.strictEqual(
      Schema.decodeUnknownSync(ChatBody)(slack.body).text,
      "🟠 monitor Site is not being checked"
    );
    const discord = Schema.decodeUnknownSync(DiscordBody)(
      alertRequest(
        "discord",
        "https://discord.com/api/webhooks/1/x",
        notChecked
      ).body
    );
    assert.strictEqual(
      discord.embeds[0]?.title,
      "🟠 monitor Site is not being checked"
    );
    assert.deepStrictEqual(discord.allowed_mentions.parse, []);
    assert.isUndefined(discord.content);
    for (const kind of ["slack", "discord", "ntfy", "webhook"] as const) {
      const request = alertRequest(kind, "https://example.com/x", notChecked);
      assert.notInclude(`${request.url}${request.body}`, "Kanshi");
    }
    const ntfy = new URL(
      alertRequest("ntfy", "https://ntfy.sh/topic", notChecked).url
    );
    assert.strictEqual(ntfy.searchParams.get("priority"), "high");
    assert.strictEqual(ntfy.searchParams.get("tags"), "warning");
  });

  it("sends webhooks a not_checked/checked event with the episode", () => {
    const request = alertRequest(
      "webhook",
      "https://example.com/hook",
      notChecked
    );
    assert.strictEqual(
      request.headers["idempotency-key"],
      "watchdog-1:down:c1"
    );
    assert.deepStrictEqual(JSON.parse(request.body), {
      episode: { ...episode, durationMs: 16 * minute },
      event: "not_checked",
      id: "watchdog-1:down:c1",
      incident: null,
      monitor,
      recovered: false,
      responseExcerpt: null,
      responseTruncated: false,
      sentAt: t0 + 16 * minute,
      text: "monitor Site is not being checked\nLast check: 16m ago (expected every 5m)\nhttps://example.com/",
      title: "monitor Site is not being checked",
    });
    const again = webhookPayload(
      AlertMessage.CheckedAgain({
        ...notCheckedAlert,
        episode: resolvedEpisode,
        idempotencyKey: "watchdog-1:up:c1",
      })
    );
    assert.strictEqual(again.event, "checked");
    assert.isTrue(again.recovered);
  });
});

type RegistryStub = ReturnType<WatchdogDeps["registries"]["getByName"]>;
type MonitorStub = ReturnType<WatchdogDeps["monitors"]["getByName"]>;

const registryRow = (
  id: string,
  overrides: Partial<RegistryEntry> = {}
): RegistryEntry => ({
  createdAt: t0,
  id,
  lifecycle: "active",
  opId: `op-${id}`,
  public: false,
  summary: summaryOf(config, snapshot().state),
  summaryRevision: 7,
  updatedAt: t0,
  watch: { episodeId: null },
  ...overrides,
});

/**
 * A watchdog over fake objects that records every call as
 * `<object>.<method>`: `snapshots` are the monitors' `reconcile()` answers,
 * `batch` the Registry's `reconcile` (null: it fails), `restored` the
 * monitors whose `reconcile()` restored a lost alarm, `rereads` the
 * monitors' later `status()` answers (default: their `snapshots`).
 * `confirmStale` opens an episode for every item it gets.
 */
const fakeWatchdog = (
  rows: readonly RegistryEntry[],
  snapshots: ReadonlyMap<string, MonitorSnapshot>,
  batch: ((items: readonly ReconcileItem[]) => ReconcileReport) | null,
  restored: ReadonlySet<string> = new Set(),
  rereads: ReadonlyMap<string, MonitorSnapshot> = snapshots
) => {
  const calls: string[] = [];
  const batches: (readonly ReconcileItem[])[] = [];
  const confirms: (readonly ReconcileItem[])[] = [];
  const registry: Pick<
    RegistryStub,
    | "activate"
    | "confirmStale"
    | "list"
    | "markDeleting"
    | "reconcile"
    | "remove"
  > = {
    activate: () => Effect.sync(() => calls.push("registry.activate") > 0),
    confirmStale: (items: readonly ReconcileItem[]) =>
      Effect.sync(() => {
        calls.push("registry.confirmStale");
        confirms.push(items);
        return {
          alarmAt: t0 + 6,
          results: items.map((item) => ({
            error: null,
            id: item.id,
            summaryUpdated: false,
            watch: {
              applied: true,
              change: "open" as const,
              episodeId: `watchdog-${item.id}`,
            },
          })),
        };
      }),
    list: () =>
      Effect.sync(() => {
        calls.push("registry.list");
        return rows;
      }),
    markDeleting: () =>
      Effect.sync(() => calls.push("registry.markDeleting") > 0),
    reconcile: (items: readonly ReconcileItem[]) =>
      Effect.suspend(() => {
        calls.push("registry.reconcile");
        batches.push(items);
        return batch === null
          ? Effect.die(new Error("registry unavailable"))
          : Effect.succeed(batch(items));
      }),
    remove: () =>
      Effect.sync(() => {
        calls.push("registry.remove");
      }),
  };
  const monitorOf = (
    id: string
  ): Pick<MonitorStub, "destroy" | "reconcile" | "status"> => ({
    destroy: () =>
      Effect.sync(() => {
        calls.push(`${id}.destroy`);
      }),
    reconcile: () =>
      Effect.sync(() => {
        calls.push(`${id}.reconcile`);
        return {
          alarmAt: t0 + 1,
          alarmRestored: restored.has(id),
          snapshot: snapshots.get(id) ?? null,
          tombstonedAt: null,
        };
      }),
    status: () =>
      Effect.sync(() => {
        calls.push(`${id}.status`);
        return {
          alarmAt: t0 + 1,
          snapshot: rereads.get(id) ?? null,
          tombstonedAt: null,
        };
      }),
  });
  const deps: WatchdogDeps = {
    // SAFETY: the run only calls `getByName` on the namespace, then
    // `destroy`, `reconcile` and `status` on the stub; this double
    // implements those.
    monitors: {
      getByName: (name: string) => monitorOf(name),
    } as WatchdogDeps["monitors"],
    // SAFETY: the run only calls `getByName` on the namespace, then
    // `activate`, `confirmStale`, `list`, `markDeleting`, `reconcile` and
    // `remove` on the stub; this double implements exactly those.
    registries: {
      getByName: (_name: string) => registry,
    } as WatchdogDeps["registries"],
  };
  return { batches, calls, confirms, deps };
};

describe(runWatchdog, () => {
  const now = t0 + 60 * minute;
  const fresh = snapshot({ lastCheckedAt: now - minute, summaryRevision: 9 });
  const stale = snapshot({ lastCheckedAt: t0, summaryRevision: 3 });
  const rows = [
    registryRow("fresh"),
    registryRow("stale"),
    registryRow("young", { createdAt: now, lifecycle: "creating" }),
    registryRow("gone", { lifecycle: "deleting" }),
  ];
  const snapshots = new Map([
    ["fresh", fresh],
    ["stale", stale],
  ]);
  const answer = (items: readonly ReconcileItem[]): ReconcileReport => ({
    alarmAt: t0 + 5,
    pruned: 0,
    results: items.map((item) => ({
      error: null,
      id: item.id,
      summaryUpdated: item.id === "fresh",
      watch: {
        applied: true,
        change:
          item.observation.stale && !item.observation.alarmRestored
            ? "suspect"
            : "none",
        episodeId: null,
      },
    })),
  });

  it.effect("makes one call per active monitor and one batched write", () =>
    Effect.gen(function* batchTest() {
      const { batches, calls, deps } = fakeWatchdog(
        rows,
        snapshots,
        answer,
        new Set(["stale"])
      );
      const report = yield* runWatchdog(deps, now);
      assert.deepStrictEqual(calls.toSorted(), [
        "fresh.reconcile",
        "gone.destroy",
        "registry.list",
        "registry.reconcile",
        "registry.remove",
        "stale.reconcile",
      ]);
      assert.strictEqual(batches.length, 1);
      assert.deepStrictEqual(batches[0], [
        {
          id: "fresh",
          observation: {
            alarmRestored: false,
            enabled: true,
            intervalSeconds: 60,
            lastCheckedAt: now - minute,
            name: "Site",
            stale: false,
            url: "https://example.com/",
          },
          revision: 9,
          summary: summaryOf(fresh.config, fresh.state),
        },
        {
          id: "stale",
          observation: {
            alarmRestored: true,
            enabled: true,
            intervalSeconds: 60,
            lastCheckedAt: t0,
            name: "Site",
            stale: true,
            url: "https://example.com/",
          },
          revision: 3,
          summary: summaryOf(stale.config, stale.state),
        },
      ]);
      assert.deepStrictEqual(
        report.results.map((result) => [
          result.id,
          result.action,
          result.outcome,
          result.summaryUpdated ?? null,
          result.watch?.change ?? null,
        ]),
        [
          ["fresh", "Refresh", "refreshed", true, "none"],
          ["stale", "Refresh", "refreshed", false, "none"],
          ["young", "Wait", "waiting", null, null],
          ["gone", "Destroy", "removed", null, null],
        ]
      );
      assert.strictEqual(report.results[0]?.alarmAt, t0 + 1);
      assert.strictEqual(report.registryAlarmAt, t0 + 5);
      assert.strictEqual(report.failed, 0);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  describe("a monitor stale at the batch", () => {
    // Not restored: the batch reports it as a suspect.
    const suspectRows = [registryRow("fresh"), registryRow("stale")];
    /** `stale`, checked just after the first read (revision bumped). */
    const checked = snapshot({ lastCheckedAt: now, summaryRevision: 4 });
    const disabled = snapshot({
      config: { enabled: false },
      lastCheckedAt: t0,
      summaryRevision: 4,
    });

    it.effect("opens an episode only after a fresh read confirms it", () =>
      Effect.gen(function* confirmTest() {
        const { calls, confirms, deps } = fakeWatchdog(
          suspectRows,
          snapshots,
          answer
        );
        const report = yield* runWatchdog(deps, now);
        // 2 + active monitors, plus one re-read per suspect and one
        // confirming write.
        assert.deepStrictEqual(calls, [
          "registry.list",
          "fresh.reconcile",
          "stale.reconcile",
          "registry.reconcile",
          "stale.status",
          "registry.confirmStale",
        ]);
        assert.deepStrictEqual(
          confirms.map((items) => items.map((item) => item.id)),
          [["stale"]]
        );
        assert.deepStrictEqual(confirms[0]?.[0]?.observation, {
          alarmRestored: false,
          enabled: true,
          intervalSeconds: 60,
          lastCheckedAt: t0,
          name: "Site",
          stale: true,
          url: "https://example.com/",
        });
        const suspect = report.results.find((result) => result.id === "stale");
        assert.isTrue(suspect?.suspect);
        assert.deepStrictEqual(suspect?.watch, {
          applied: true,
          change: "open",
          episodeId: "watchdog-stale",
        });
        assert.deepStrictEqual(suspect?.errors, []);
        assert.isUndefined(
          report.results.find((result) => result.id === "fresh")?.suspect
        );
        assert.strictEqual(report.registryAlarmAt, t0 + 6);
      }).pipe(Effect.provide(RuntimeContext.phantom))
    );

    it.effect("opens an episode for a monitor renamed before the re-read", () =>
      Effect.gen(function* renamedTest() {
        const renamed = snapshot({
          config: { name: "Renamed" },
          lastCheckedAt: t0,
          summaryRevision: 4,
        });
        const { calls, confirms, deps } = fakeWatchdog(
          suspectRows,
          snapshots,
          answer,
          new Set(),
          new Map([["stale", renamed]])
        );
        const report = yield* runWatchdog(deps, now);
        assert.deepStrictEqual(calls, [
          "registry.list",
          "fresh.reconcile",
          "stale.reconcile",
          "registry.reconcile",
          "stale.status",
          "registry.confirmStale",
        ]);
        // Sent with the fresh read's revision and summary.
        assert.strictEqual(confirms[0]?.[0]?.revision, 4);
        assert.strictEqual(confirms[0]?.[0]?.observation.name, "Renamed");
        assert.strictEqual(confirms[0]?.[0]?.summary.name, "Renamed");
        assert.deepStrictEqual(
          report.results.find((result) => result.id === "stale")?.watch,
          { applied: true, change: "open", episodeId: "watchdog-stale" }
        );
      }).pipe(Effect.provide(RuntimeContext.phantom))
    );

    for (const [label, reread] of [
      ["checked", checked],
      ["disabled", disabled],
      [
        "restarted",
        snapshot({
          config: { timeoutMs: 5000 },
          lastCheckedAt: t0,
          scheduleResetAt: now - minute,
          summaryRevision: 3,
        }),
      ],
    ] as const) {
      it.effect(`opens nothing for a monitor ${label} before the re-read`, () =>
        Effect.gen(function* dismissTest() {
          const { calls, confirms, deps } = fakeWatchdog(
            suspectRows,
            snapshots,
            answer,
            new Set(),
            new Map([["stale", reread]])
          );
          const report = yield* runWatchdog(deps, now);
          assert.deepStrictEqual(calls, [
            "registry.list",
            "fresh.reconcile",
            "stale.reconcile",
            "registry.reconcile",
            "stale.status",
          ]);
          assert.deepStrictEqual(confirms, []);
          const suspect = report.results.find(
            (result) => result.id === "stale"
          );
          assert.isTrue(suspect?.suspect);
          assert.deepStrictEqual(suspect?.watch, {
            applied: false,
            change: "none",
            episodeId: null,
          });
          assert.strictEqual(suspect?.outcome, "refreshed");
          assert.strictEqual(report.registryAlarmAt, t0 + 5);
        }).pipe(Effect.provide(RuntimeContext.phantom))
      );
    }

    it.effect("makes no extra call when nothing is a suspect", () =>
      Effect.gen(function* steadyTest() {
        const { calls, deps } = fakeWatchdog(
          [registryRow("fresh")],
          snapshots,
          answer
        );
        yield* runWatchdog(deps, now);
        assert.deepStrictEqual(calls, [
          "registry.list",
          "fresh.reconcile",
          "registry.reconcile",
        ]);
      }).pipe(Effect.provide(RuntimeContext.phantom))
    );
  });

  it.effect("still makes the batched write with no active monitors", () =>
    Effect.gen(function* emptyTest() {
      const { batches, calls, deps } = fakeWatchdog([], new Map(), answer);
      yield* runWatchdog(deps, now);
      assert.deepStrictEqual(calls, ["registry.list", "registry.reconcile"]);
      assert.deepStrictEqual(batches, [[]]);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  it.effect("reports every refresh as failed when the batch fails", () =>
    Effect.gen(function* failedBatchTest() {
      const { deps } = fakeWatchdog(rows, snapshots, null);
      const report = yield* runWatchdog(deps, now);
      const refreshed = report.results.filter(
        (result) => result.action === "Refresh"
      );
      assert.strictEqual(refreshed.length, 2);
      for (const result of refreshed) {
        assert.strictEqual(result.outcome, "partly failed");
        assert.match(result.errors[0] ?? "", /^reconcile: /u);
      }
      assert.strictEqual(report.failed, 2);
      assert.isNull(report.registryAlarmAt);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );
});
