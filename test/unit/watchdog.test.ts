import { assert, describe, it } from "@effect/vitest";
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
} from "../../src/domain/monitor.ts";
import { initialState } from "../../src/monitor/cycle.ts";
import { applyConfigChange } from "../../src/monitor/reset.ts";
import type {
  WatchdogRow,
  WatchdogStatus,
  WatchState,
} from "../../src/watchdog/rules.ts";
import {
  creatingGraceMs,
  decide,
  isStale,
  lastSignOfLife,
  needsStatus,
  staleRunsToAlert,
  staleThresholdMs,
  WatchdogAction,
  watchTransition,
} from "../../src/watchdog/rules.ts";

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
  key: "m1",
  managed: false,
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
  snapshot: value,
  tombstonedAt: null,
});
const unconfigured: WatchdogStatus = { snapshot: null, tombstonedAt: null };
const tombstoned: WatchdogStatus = { snapshot: null, tombstonedAt: t0 };

describe("watchdog decisions", () => {
  it("leaves a young creating row alone and needs no status for it", () => {
    const young = row({ lifecycle: "creating" });
    const now = t0 + creatingGraceMs - 1;
    assert.isFalse(needsStatus(young, now));
    assert.deepStrictEqual(decide(young, null, now), WatchdogAction.Wait());
  });

  it("activates a stuck create whose monitor was configured", () => {
    const stuck = row({ lifecycle: "creating", opId: "op9" });
    const now = t0 + creatingGraceMs;
    assert.isTrue(needsStatus(stuck, now));
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
      decide(stuck, { snapshot: snapshot(), tombstonedAt: t0 }, now),
      WatchdogAction.Abandon({ opId: "op9" })
    );
  });

  it("skips a stuck create when its status could not be fetched", () => {
    const stuck = row({ lifecycle: "creating" });
    assert.strictEqual(decide(stuck, null, t0 + 10 * minute)._tag, "Skip");
  });

  it("retries a stuck delete whatever its age, without a status", () => {
    const deleting = row({ lifecycle: "deleting" });
    assert.isFalse(needsStatus(deleting, t0));
    assert.deepStrictEqual(
      decide(deleting, null, t0),
      WatchdogAction.Destroy()
    );
  });

  it("refreshes an active monitor with its summary and revision", () => {
    const now = t0 + minute;
    const value = snapshot({ lastCheckedAt: t0 + 30_000, summaryRevision: 12 });
    assert.isTrue(needsStatus(row(), t0));
    assert.deepStrictEqual(
      decide(row(), live(value), now),
      WatchdogAction.Refresh({
        observation: {
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
          lastCheckedAt: t0 + 30_000,
          name: "Site",
          status: "up",
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
  it("allows two intervals plus two minutes", () => {
    assert.strictEqual(staleThresholdMs(60), 4 * minute);
    assert.strictEqual(staleThresholdMs(5), 2 * minute + 10_000);
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
    // Last checked at t0, stale since t0 + 4 minutes; edited at t0 + 10.
    const stale = snapshot({ lastCheckedAt: t0 });
    const editedAt = t0 + 10 * minute;
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
        { managed: true },
      ] satisfies readonly Partial<MonitorConfig>[]) {
        const edited = edit(patch);
        assert.strictEqual(edited.config.updatedAt, editedAt);
        assert.isTrue(isStale(edited, editedAt + 1), JSON.stringify(patch));
      }
    });

    it("restarts the clock on a probe-affecting edit", () => {
      const edited = edit({ timeoutMs: 5000 });
      assert.strictEqual(lastSignOfLife(edited), editedAt);
      assert.isFalse(isStale(edited, editedAt + 4 * minute));
      assert.isTrue(isStale(edited, editedAt + 4 * minute + 1));
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
      assert.isFalse(isStale(value, editedAt + 4 * minute));
    });
  });

  it("is stale only strictly past the threshold, and only when enabled", () => {
    const value = snapshot({ lastCheckedAt: t0 });
    assert.isFalse(isStale(value, t0 + 4 * minute));
    assert.isTrue(isStale(value, t0 + 4 * minute + 1));
    const disabled = snapshot({
      config: { enabled: false },
      lastCheckedAt: t0,
    });
    assert.isFalse(isStale(disabled, t0 + 60 * minute));
  });

  it("counts a never-checked monitor from its creation", () => {
    assert.isFalse(isStale(snapshot(), t0 + 4 * minute));
    assert.isTrue(isStale(snapshot(), t0 + 5 * minute));
  });
});

describe("stale counter and dedup", () => {
  const fresh = { enabled: true, stale: false };
  const stale = { enabled: true, stale: true };
  const disabled = { enabled: false, stale: false };

  /** Run the transition over observations, starting from a clean state. */
  const run = (observations: readonly (typeof fresh)[]) => {
    let state: WatchState = { episodeId: null, staleRuns: 0 };
    const changes: string[] = [];
    for (const observation of observations) {
      const next = watchTransition(state, observation);
      changes.push(next.change);
      let { episodeId } = state;
      if (next.change === "open") {
        episodeId = "ep";
      } else if (next.change !== "none") {
        episodeId = null;
      }
      state = { episodeId, staleRuns: next.staleRuns };
    }
    return { changes, state };
  };

  it("alerts on the second consecutive stale run", () => {
    assert.strictEqual(staleRunsToAlert, 2);
    assert.deepStrictEqual(run([stale]).changes, ["none"]);
    assert.deepStrictEqual(run([stale, stale]).changes, ["none", "open"]);
  });

  it("needs the stale runs to be consecutive", () => {
    assert.deepStrictEqual(run([stale, fresh, stale, fresh]).changes, [
      "none",
      "none",
      "none",
      "none",
    ]);
  });

  it("alerts once per episode, however long it lasts", () => {
    const result = run([stale, stale, stale, stale, stale]);
    assert.deepStrictEqual(result.changes, [
      "none",
      "open",
      "none",
      "none",
      "none",
    ]);
    assert.strictEqual(result.state.staleRuns, 5);
    assert.strictEqual(result.state.episodeId, "ep");
  });

  it("resolves when checks resume, and can alert again later", () => {
    assert.deepStrictEqual(run([stale, stale, fresh, stale, stale]).changes, [
      "none",
      "open",
      "resolve",
      "none",
      "open",
    ]);
  });

  it("closes silently when the monitor is disabled", () => {
    const result = run([stale, stale, disabled]);
    assert.deepStrictEqual(result.changes, ["none", "open", "close"]);
    assert.deepStrictEqual(result.state, { episodeId: null, staleRuns: 0 });
    assert.deepStrictEqual(run([stale, disabled, stale]).changes, [
      "none",
      "none",
      "none",
    ]);
  });
});

const ChatBody = Schema.fromJsonString(Schema.Struct({ text: Schema.String }));

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

  it("prefixes chat messages with Kanshi", () => {
    const slack = alertRequest(
      "slack",
      "https://hooks.slack.com/x",
      notChecked
    );
    assert.match(
      Schema.decodeUnknownSync(ChatBody)(slack.body).text,
      /^Kanshi: monitor Site is not being checked\n/u
    );
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
