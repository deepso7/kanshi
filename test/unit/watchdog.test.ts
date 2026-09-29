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
} from "../../src/domain/monitor.ts";
import { summaryOf } from "../../src/domain/monitor.ts";
import { initialState } from "../../src/monitor/cycle.ts";
import { applyConfigChange } from "../../src/monitor/reset.ts";
import type {
  ReconcileReport,
  RegistryEntry,
} from "../../src/registry/registry.ts";
import type {
  ReconcileItem,
  WatchdogRow,
  WatchdogStatus,
  WatchState,
} from "../../src/watchdog/rules.ts";
import {
  creatingGraceMs,
  decide,
  isStale,
  lastSignOfLife,
  needsReconcile,
  staleFloorMs,
  staleThresholdMs,
  WatchdogAction,
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
  const fresh = { enabled: true, stale: false };
  const stale = { enabled: true, stale: true };
  const disabled = { enabled: false, stale: false };

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

type RegistryStub = ReturnType<WatchdogDeps["registries"]["getByName"]>;
type MonitorStub = ReturnType<WatchdogDeps["monitors"]["getByName"]>;

const registryRow = (
  id: string,
  overrides: Partial<RegistryEntry> = {}
): RegistryEntry => ({
  createdAt: t0,
  id,
  key: id,
  lifecycle: "active",
  managed: false,
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
 * `batch` the Registry's `reconcile` (null: it fails).
 */
const fakeWatchdog = (
  rows: readonly RegistryEntry[],
  snapshots: ReadonlyMap<string, MonitorSnapshot>,
  batch: ((items: readonly ReconcileItem[]) => ReconcileReport) | null
) => {
  const calls: string[] = [];
  const batches: (readonly ReconcileItem[])[] = [];
  const registry: Pick<
    RegistryStub,
    "activate" | "list" | "markDeleting" | "reconcile" | "remove"
  > = {
    activate: () => Effect.sync(() => calls.push("registry.activate") > 0),
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
  ): Pick<MonitorStub, "destroy" | "reconcile"> => ({
    destroy: () =>
      Effect.sync(() => {
        calls.push(`${id}.destroy`);
      }),
    reconcile: () =>
      Effect.sync(() => {
        calls.push(`${id}.reconcile`);
        return {
          alarmAt: t0 + 1,
          snapshot: snapshots.get(id) ?? null,
          tombstonedAt: null,
        };
      }),
  });
  const deps: WatchdogDeps = {
    // SAFETY: the run only calls `getByName` on the namespace, then
    // `destroy` and `reconcile` on the stub; this double implements those.
    monitors: {
      getByName: (name: string) => monitorOf(name),
    } as WatchdogDeps["monitors"],
    // SAFETY: the run only calls `getByName` on the namespace, then
    // `activate`, `list`, `markDeleting`, `reconcile` and `remove` on the
    // stub; this double implements exactly those.
    registries: {
      getByName: (_name: string) => registry,
    } as WatchdogDeps["registries"],
  };
  return { batches, calls, deps };
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
        change: item.observation.stale ? "open" : "none",
        episodeId: item.observation.stale ? "watchdog-1" : null,
      },
    })),
  });

  it.effect("makes one call per active monitor and one batched write", () =>
    Effect.gen(function* batchTest() {
      const { batches, calls, deps } = fakeWatchdog(rows, snapshots, answer);
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
          ["stale", "Refresh", "refreshed", false, "open"],
          ["young", "Wait", "waiting", null, null],
          ["gone", "Destroy", "removed", null, null],
        ]
      );
      assert.strictEqual(report.results[0]?.alarmAt, t0 + 1);
      assert.strictEqual(report.registryAlarmAt, t0 + 5);
      assert.strictEqual(report.failed, 0);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

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
