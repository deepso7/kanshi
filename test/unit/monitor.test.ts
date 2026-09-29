import { assert, describe, it } from "@effect/vitest";

import type {
  MonitorConfig,
  MonitorState,
  ProbeOutcome,
} from "../../src/domain/monitor.ts";
import { shouldPushSummary } from "../../src/domain/monitor.ts";
import {
  alignSlot,
  completeCheck,
  Completion,
  confirmDelayMs,
  dueCheck,
  expireInflight,
  inflightGraceMs,
  initialState,
  nextAlarmAt,
  startCheck,
} from "../../src/monitor/cycle.ts";
import { nextMaintenanceTime } from "../../src/monitor/history.ts";
import { evaluate } from "../../src/monitor/machine.ts";
import { applyConfigChange } from "../../src/monitor/reset.ts";

const t0 = 1_000_000;
const intervalMs = 60_000;

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
  key: "m1",
  managed: false,
  method: "GET",
  name: "Site",
  successThreshold: 1,
  timeoutMs: 10_000,
  updatedAt: t0,
  url: "https://example.com/",
};

const up: ProbeOutcome = {
  errorKind: null,
  latencyMs: 12,
  message: null,
  ok: true,
  status: 200,
};
const down: ProbeOutcome = {
  errorKind: "status",
  latencyMs: 12,
  message: "expected 2xx, got 500",
  ok: false,
  status: 500,
};

const committed = (completion: Completion) => {
  assert.strictEqual(completion._tag, "Committed");
  if (!Completion.$is("Committed")(completion)) {
    throw new Error("expected a committed result");
  }
  return completion;
};

let checkCounter = 0;

/** Run the check that is due at `at`, returning the committed completion. */
const runDue = (
  cfg: MonitorConfig,
  state: MonitorState,
  outcome: ProbeOutcome,
  at: number,
  finishAt = at + 100
) => {
  const kind = dueCheck(cfg, state, at);
  assert.isNotNull(kind, "a check should be due");
  if (kind === null) {
    throw new Error("no check due");
  }
  checkCounter += 1;
  const started = startCheck(cfg, state, kind, `c${checkCounter}`, at);
  return committed(
    completeCheck(cfg, started.state, started.inflight, outcome, finishAt)
  );
};

describe("state machine", () => {
  const streaks = {
    failureStreak: 0,
    status: "unknown" as const,
    successStreak: 0,
  };

  it("goes down after failureThreshold failures", () => {
    const thresholds = { failureThreshold: 2, successThreshold: 1 };
    const first = evaluate(streaks, thresholds, { ok: false });
    assert.strictEqual(first.state.status, "unknown");
    assert.strictEqual(first.transition, "none");
    const second = evaluate(first.state, thresholds, { ok: false });
    assert.strictEqual(second.state.status, "down");
    assert.strictEqual(second.transition, "down");
    const third = evaluate(second.state, thresholds, { ok: false });
    assert.strictEqual(third.transition, "none");
  });

  it("recovers after successThreshold successes", () => {
    const thresholds = { failureThreshold: 1, successThreshold: 2 };
    const isDown = {
      failureStreak: 3,
      status: "down" as const,
      successStreak: 0,
    };
    const first = evaluate(isDown, thresholds, { ok: true });
    assert.strictEqual(first.state.status, "down");
    assert.strictEqual(first.state.failureStreak, 0);
    const second = evaluate(first.state, thresholds, { ok: true });
    assert.strictEqual(second.state.status, "up");
    assert.strictEqual(second.transition, "up");
  });

  it("unknown to up is not a transition", () => {
    const result = evaluate(
      streaks,
      { failureThreshold: 1, successThreshold: 1 },
      { ok: true }
    );
    assert.strictEqual(result.state.status, "up");
    assert.strictEqual(result.transition, "none");
  });

  it("a failure resets the success streak", () => {
    const result = evaluate(
      { failureStreak: 0, status: "up" as const, successStreak: 5 },
      { failureThreshold: 3, successThreshold: 1 },
      { ok: false }
    );
    assert.strictEqual(result.state.successStreak, 0);
    assert.strictEqual(result.state.failureStreak, 1);
    assert.strictEqual(result.state.status, "up");
  });
});

describe("check cycle", () => {
  it("a scheduled success is counted and schedules the next slot", () => {
    const result = runDue(config, initialState(t0), up, t0);
    assert.isTrue(result.check.counted);
    assert.strictEqual(result.state.status, "up");
    assert.strictEqual(result.state.nextCheckKind, "scheduled");
    assert.strictEqual(result.state.nextCheckAt, t0 + intervalMs);
    assert.isNull(result.state.inflight);
    assert.strictEqual(result.state.lastCheckedAt, t0 + 100);
  });

  it("a scheduled failure is confirmed 5s later and only the confirm counts", () => {
    const failed = runDue(config, initialState(t0), down, t0);
    assert.isFalse(failed.check.counted);
    assert.strictEqual(failed.transition, "none");
    assert.strictEqual(failed.state.status, "unknown");
    assert.strictEqual(failed.state.nextCheckKind, "confirm");
    assert.strictEqual(failed.state.nextCheckAt, t0 + 100 + confirmDelayMs);
    assert.isNull(dueCheck(config, failed.state, t0 + 200));

    const confirmAt = failed.state.nextCheckAt;
    const confirmed = runDue(config, failed.state, down, confirmAt);
    assert.strictEqual(confirmed.check.kind, "confirm");
    assert.isTrue(confirmed.check.counted);
    assert.strictEqual(confirmed.transition, "down");
    assert.strictEqual(confirmed.state.status, "down");
    assert.isNotNull(confirmed.openIncident);
    assert.strictEqual(
      confirmed.state.openIncidentId,
      confirmed.openIncident?.id
    );
    // Back on the slot grid.
    assert.strictEqual(confirmed.state.nextCheckKind, "scheduled");
    assert.strictEqual(confirmed.state.nextCheckAt, t0 + intervalMs);
  });

  it("a successful confirm clears a transient failure", () => {
    const failed = runDue(config, initialState(t0), down, t0);
    const confirmed = runDue(
      config,
      failed.state,
      up,
      failed.state.nextCheckAt
    );
    assert.strictEqual(confirmed.state.status, "up");
    assert.strictEqual(confirmed.transition, "none");
    assert.isNull(confirmed.openIncident);
  });

  it("while down, scheduled failures count directly and recovery closes the incident", () => {
    const failed = runDue(config, initialState(t0), down, t0);
    const isDown = runDue(config, failed.state, down, failed.state.nextCheckAt);
    const again = runDue(config, isDown.state, down, t0 + intervalMs);
    assert.isTrue(again.check.counted);
    assert.strictEqual(again.state.nextCheckKind, "scheduled");
    assert.strictEqual(again.transition, "none");
    const recovered = runDue(config, again.state, up, t0 + 2 * intervalMs);
    assert.strictEqual(recovered.transition, "up");
    assert.strictEqual(recovered.closeIncident?.id, isDown.openIncident?.id);
    assert.isNull(recovered.state.openIncidentId);
  });

  it("skips missed slots instead of bursting", () => {
    const late = t0 + 3.5 * intervalMs;
    const result = runDue(config, initialState(t0), up, late, late);
    assert.strictEqual(result.state.nextCheckAt, t0 + 4 * intervalMs);
    assert.strictEqual(alignSlot(t0, intervalMs, t0), t0);
    assert.strictEqual(alignSlot(t0, intervalMs, t0 + 1), t0 + intervalMs);
  });

  it("discards a result whose check was superseded or whose generation changed", () => {
    const started = startCheck(
      config,
      initialState(t0),
      "scheduled",
      "c-old",
      t0
    );
    const edited = applyConfigChange(
      config,
      { ...config, url: "https://example.org/" },
      started.state,
      t0 + 50
    );
    assert.isNull(edited.state.inflight);
    assert.deepStrictEqual(
      completeCheck(
        edited.config,
        edited.state,
        started.inflight,
        down,
        t0 + 100
      ),
      Completion.Stale()
    );
    // A newer check started under the new generation is also not ours.
    const newer = startCheck(
      edited.config,
      edited.state,
      "scheduled",
      "c-new",
      t0 + 60
    );
    assert.deepStrictEqual(
      completeCheck(
        edited.config,
        newer.state,
        started.inflight,
        down,
        t0 + 100
      ),
      Completion.Stale()
    );
    assert.strictEqual(
      completeCheck(edited.config, newer.state, newer.inflight, up, t0 + 100)
        ._tag,
      "Committed"
    );
  });

  it("expires an in-flight check after timeout + grace", () => {
    const started = startCheck(config, initialState(t0), "scheduled", "c1", t0);
    const deadline = t0 + config.timeoutMs + inflightGraceMs;
    assert.isNull(expireInflight(config, started.state, deadline - 1));
    assert.isNull(dueCheck(config, started.state, deadline));
    const expired = expireInflight(config, started.state, deadline);
    assert.isNotNull(expired);
    if (expired !== null) {
      assert.isNull(expired.inflight);
      // The slot is still due, so it is retried.
      assert.strictEqual(dueCheck(config, expired, deadline), "scheduled");
    }
    // The lost probe cannot commit afterwards.
    if (expired !== null) {
      assert.deepStrictEqual(
        completeCheck(config, expired, started.inflight, up, deadline + 1),
        Completion.Stale()
      );
    }
  });

  it("runs a manual request as an uncounted check that keeps the slot", () => {
    const first = runDue(config, initialState(t0), up, t0);
    const requested = { ...first.state, manualRequestedAt: t0 + 1000 };
    assert.strictEqual(dueCheck(config, requested, t0 + 1000), "manual");
    const manual = runDue(config, requested, up, t0 + 1000);
    assert.strictEqual(manual.check.kind, "manual");
    assert.isFalse(manual.check.counted);
    assert.isNull(manual.state.manualRequestedAt);
    assert.strictEqual(manual.state.nextCheckAt, t0 + intervalMs);
    assert.strictEqual(manual.state.nextCheckKind, "scheduled");
  });

  it("a manual failure schedules an uncounted confirm and keeps the slot", () => {
    const first = runDue(config, initialState(t0), up, t0);
    const requested = { ...first.state, manualRequestedAt: t0 + 1000 };
    const manual = runDue(config, requested, down, t0 + 1000);
    assert.strictEqual(manual.state.status, "up");
    assert.strictEqual(manual.state.nextCheckKind, "confirm");
    const confirmed = runDue(
      config,
      manual.state,
      down,
      manual.state.nextCheckAt
    );
    assert.isFalse(confirmed.check.counted);
    assert.strictEqual(confirmed.transition, "down");
    assert.strictEqual(confirmed.state.nextCheckAt, t0 + intervalMs);
  });

  it("a manual request made during an in-flight check survives it", () => {
    const started = startCheck(config, initialState(t0), "scheduled", "c1", t0);
    const requested = { ...started.state, manualRequestedAt: t0 + 500 };
    assert.isNull(dueCheck(config, requested, t0 + 500));
    const done = committed(
      completeCheck(config, requested, started.inflight, up, t0 + 1000)
    );
    assert.strictEqual(done.state.manualRequestedAt, t0 + 500);
    assert.strictEqual(dueCheck(config, done.state, t0 + 1000), "manual");
  });

  it("a scheduled check answers a manual request made before it started", () => {
    const requested = { ...initialState(t0), manualRequestedAt: t0 - 10 };
    assert.strictEqual(dueCheck(config, requested, t0), "scheduled");
    const done = runDue(config, requested, up, t0);
    assert.isNull(done.state.manualRequestedAt);
  });

  it("disabled monitors run nothing", () => {
    const disabled = { ...config, enabled: false };
    const requested = { ...initialState(t0), manualRequestedAt: t0 };
    assert.isNull(dueCheck(disabled, requested, t0 + intervalMs));
  });
});

describe("alarm computation", () => {
  it("is the next due check when idle", () => {
    assert.strictEqual(nextAlarmAt(config, initialState(t0)), t0);
  });

  it("includes a pending manual request", () => {
    const state = {
      ...initialState(t0),
      manualRequestedAt: t0 - 5,
      nextCheckAt: t0 + intervalMs,
    };
    assert.strictEqual(nextAlarmAt(config, state), t0 - 5);
  });

  it("is the in-flight deadline while a check runs", () => {
    const started = startCheck(config, initialState(t0), "scheduled", "c1", t0);
    const state = { ...started.state, manualRequestedAt: t0 + 1 };
    assert.strictEqual(
      nextAlarmAt(config, state),
      t0 + config.timeoutMs + inflightGraceMs
    );
  });

  it("ignores checks while disabled but keeps other work", () => {
    const disabled = { ...config, enabled: false };
    const idle = { ...initialState(t0), nextMaintenanceAt: null };
    assert.isNull(nextAlarmAt(disabled, idle));
    const maintenance = { ...idle, nextMaintenanceAt: t0 + 5 };
    assert.strictEqual(nextAlarmAt(disabled, maintenance), t0 + 5);
    assert.strictEqual(nextAlarmAt(disabled, idle, [null, t0 + 7]), t0 + 7);
  });

  it("a fresh monitor schedules daily maintenance, even while disabled", () => {
    const fresh = initialState(t0);
    assert.strictEqual(fresh.nextMaintenanceAt, nextMaintenanceTime(t0));
    assert.strictEqual(
      nextAlarmAt({ ...config, enabled: false }, fresh),
      fresh.nextMaintenanceAt
    );
  });

  it("takes the earliest candidate", () => {
    const state = { ...initialState(t0), nextMaintenanceAt: t0 + 100 };
    assert.strictEqual(nextAlarmAt(config, state, [t0 - 1]), t0 - 1);
  });
});

const downState = (): MonitorState => {
  const failed = runDue(config, initialState(t0), down, t0);
  const started = startCheck(
    config,
    failed.state,
    "confirm",
    "c-confirm",
    failed.state.nextCheckAt
  );
  const confirmed = committed(
    completeCheck(
      config,
      started.state,
      started.inflight,
      down,
      started.inflight.startedAt + 10
    )
  );
  return {
    ...confirmed.state,
    manualRequestedAt: t0 + 7,
    nextCheckAt: t0 + intervalMs + 1,
    nextCheckKind: "confirm",
  };
};

describe("reset rules", () => {
  it("a probe-affecting edit bumps generation, resets streaks, clears confirm, keeps status", () => {
    const state = downState();
    const change = applyConfigChange(
      config,
      { ...config, timeoutMs: 5000 },
      state,
      t0 + 999
    );
    assert.strictEqual(change.config.generation, 1);
    assert.strictEqual(change.state.status, "down");
    assert.strictEqual(change.state.failureStreak, 0);
    assert.strictEqual(change.state.nextCheckAt, t0 + 999);
    assert.strictEqual(change.state.nextCheckKind, "scheduled");
    assert.strictEqual(change.state.scheduleResetAt, t0 + 999);
    assert.isNull(change.state.inflight);
    assert.isNull(change.closeIncident);
    assert.strictEqual(change.state.openIncidentId, state.openIncidentId);
  });

  it("a cosmetic edit does not bump generation", () => {
    const state = downState();
    const change = applyConfigChange(
      config,
      { ...config, name: "Renamed" },
      state,
      t0 + 999
    );
    assert.strictEqual(change.config.generation, 0);
    assert.strictEqual(change.state.failureStreak, state.failureStreak);
    assert.strictEqual(change.state.scheduleResetAt, state.scheduleResetAt);
    assert.strictEqual(change.state.summaryRevision, state.summaryRevision + 1);
    const noop = applyConfigChange(config, config, state, t0 + 999);
    assert.strictEqual(noop.state.summaryRevision, state.summaryRevision);
  });

  it("disable closes the open incident as disabled and resets to unknown", () => {
    const state = downState();
    const change = applyConfigChange(
      config,
      { ...config, enabled: false },
      state,
      t0 + 999
    );
    assert.strictEqual(change.config.generation, 1);
    assert.strictEqual(change.state.status, "unknown");
    assert.strictEqual(change.state.failureStreak, 0);
    assert.strictEqual(change.closeIncident?.resolution, "disabled");
    assert.strictEqual(change.closeIncident?.id, state.openIncidentId);
    assert.isNull(change.state.openIncidentId);
    assert.isNull(change.state.manualRequestedAt);
    assert.strictEqual(change.state.nextCheckKind, "scheduled");
    // Only maintenance keeps waking a disabled monitor.
    assert.strictEqual(
      nextAlarmAt(change.config, change.state),
      state.nextMaintenanceAt
    );
  });

  it("enable bumps generation and checks now, so a down target opens a new incident", () => {
    const disabled = applyConfigChange(
      config,
      { ...config, enabled: false },
      downState(),
      t0 + 999
    );
    const enabled = applyConfigChange(
      disabled.config,
      { ...disabled.config, enabled: true },
      disabled.state,
      t0 + 2000
    );
    assert.strictEqual(enabled.config.generation, 2);
    assert.strictEqual(enabled.state.status, "unknown");
    assert.strictEqual(enabled.state.scheduleResetAt, t0 + 2000);
    assert.strictEqual(nextAlarmAt(enabled.config, enabled.state), t0 + 2000);
    const failed = runDue(enabled.config, enabled.state, down, t0 + 2000);
    const reopened = runDue(
      enabled.config,
      failed.state,
      down,
      failed.state.nextCheckAt
    );
    assert.strictEqual(reopened.transition, "down");
    assert.isNotNull(reopened.openIncident);
  });
});

/** Whether the Monitor would push after `before` -> `after`. */
const pushes = (
  before: { config: MonitorConfig; state: MonitorState },
  after: { config: MonitorConfig; state: MonitorState }
) => shouldPushSummary(before, after);

/** An up monitor, checked once. */
const upState = () =>
  runDue(config, initialState(t0), up, t0).state satisfies MonitorState;

describe(shouldPushSummary, () => {
  it("pushes a newly configured monitor", () => {
    assert.isTrue(shouldPushSummary(null, { config, state: initialState(t0) }));
  });

  it("does not push a check that leaves the status alone", () => {
    let state = upState();
    for (let slot = 1; slot <= 5; slot += 1) {
      const next = runDue(config, state, up, state.nextCheckAt).state;
      assert.isFalse(pushes({ config, state }, { config, state: next }));
      assert.strictEqual(next.summaryRevision, state.summaryRevision);
      assert.isAbove(next.lastCheckedAt ?? 0, state.lastCheckedAt ?? 0);
      state = next;
    }
  });

  it("does not push an unconfirmed failure, only the confirmed transition", () => {
    const state = upState();
    const failed = runDue(config, state, down, state.nextCheckAt);
    assert.strictEqual(failed.state.status, "up");
    assert.isFalse(pushes({ config, state }, { config, state: failed.state }));
    const confirmed = runDue(
      config,
      failed.state,
      down,
      failed.state.nextCheckAt
    );
    assert.strictEqual(confirmed.transition, "down");
    assert.isTrue(
      pushes(
        { config, state: failed.state },
        { config, state: confirmed.state }
      )
    );
    assert.strictEqual(
      confirmed.state.summaryRevision,
      state.summaryRevision + 1
    );
  });

  it("pushes the first result of a new monitor (unknown to up)", () => {
    const state = initialState(t0);
    const checked = runDue(config, state, up, t0).state;
    assert.isTrue(pushes({ config, state }, { config, state: checked }));
  });

  it("pushes edits of what the Registry shows, not of anything else", () => {
    const state = upState();
    const edit = (patch: Partial<MonitorConfig>) => {
      const after = { ...config, ...patch, updatedAt: t0 + 999 };
      const change = applyConfigChange(config, after, state, t0 + 999);
      return pushes({ config, state }, change);
    };
    for (const patch of [
      { name: "Renamed" },
      { url: "https://example.org/" },
      { intervalSeconds: 120 },
      { enabled: false },
    ] satisfies readonly Partial<MonitorConfig>[]) {
      assert.isTrue(edit(patch), JSON.stringify(patch));
    }
    for (const patch of [
      { channels: ["c1"] },
      { managed: true },
      { timeoutMs: 5000 },
      { failureThreshold: 3 },
    ] satisfies readonly Partial<MonitorConfig>[]) {
      assert.isFalse(edit(patch), JSON.stringify(patch));
    }
  });

  it("pushes enable of a disabled monitor", () => {
    const state = upState();
    const disabled = applyConfigChange(
      config,
      { ...config, enabled: false },
      state,
      t0 + 999
    );
    const enabled = applyConfigChange(
      disabled.config,
      { ...disabled.config, enabled: true },
      disabled.state,
      t0 + 2000
    );
    assert.isTrue(pushes(disabled, enabled));
    assert.isAbove(
      enabled.state.summaryRevision,
      disabled.state.summaryRevision
    );
  });
});
