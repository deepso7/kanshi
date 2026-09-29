import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";

import type { RecentActivity } from "../../src/domain/history.ts";
import type {
  MonitorConfig,
  MonitorSnapshot,
} from "../../src/domain/monitor.ts";
import { summaryOf } from "../../src/domain/monitor.ts";
import type { Episode } from "../../src/domain/watchdog.ts";
import { initialState } from "../../src/monitor/cycle.ts";
import { InvalidMonitorInput } from "../../src/monitor/errors.ts";
import type { RegistryEntry } from "../../src/registry/registry.ts";
import type { MonitorServiceDeps } from "../../src/service/monitors.ts";
import {
  makeMonitorService,
  overviewConcurrency,
  statusCounts,
  toOverview,
} from "../../src/service/monitors.ts";

const t0 = 1_000_000;

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

const snapshot: MonitorSnapshot = { config, state: initialState(t0) };

const entry: RegistryEntry = {
  createdAt: t0,
  id: "m1",
  key: "m1",
  lifecycle: "active",
  managed: false,
  opId: "op1",
  public: false,
  summary: summaryOf(config, snapshot.state),
  summaryRevision: 0,
  updatedAt: t0,
  watch: { episodeId: null, staleRuns: 0 },
};

type RegistryStub = ReturnType<MonitorServiceDeps["registries"]["getByName"]>;
type MonitorStub = ReturnType<MonitorServiceDeps["monitors"]["getByName"]>;

/**
 * A service over fake objects whose `update` fails like a concurrent edit
 * that made the patch invalid after the snapshot check passed.
 */
const makeRacingService = (
  update: () => Effect.Effect<MonitorSnapshot, InvalidMonitorInput>
) => {
  const writes: string[] = [];
  const registry: Pick<RegistryStub, "get" | "missingChannels" | "setPublic"> =
    {
      get: () => Effect.succeed(entry),
      missingChannels: () => Effect.succeed([]),
      setPublic: (_id: string, isPublic: boolean) =>
        Effect.sync(() => {
          writes.push(`public=${String(isPublic)}`);
          return true;
        }),
    };
  const monitor: Pick<MonitorStub, "snapshot" | "update"> = {
    snapshot: () => Effect.succeed(snapshot),
    update,
  };
  const service = makeMonitorService({
    devMode: false,
    // SAFETY: the update path only calls `getByName` on the namespace, then
    // `snapshot` and `update` on the stub; this double implements exactly those.
    monitors: {
      getByName: (_name: string) => monitor,
    } as MonitorServiceDeps["monitors"],
    quota: 10,
    // SAFETY: the update path only calls `getByName` on the namespace, then
    // `get`, `missingChannels` and `setPublic` on the stub; this double
    // implements exactly those.
    registries: {
      getByName: (_name: string) => registry,
    } as MonitorServiceDeps["registries"],
  });
  return { service, writes };
};

describe("monitor update after setting public", () => {
  it.effect("a concurrent invalidating edit is a 409 naming the change", () =>
    Effect.gen(function* raceTest() {
      const { service, writes } = makeRacingService(() =>
        Effect.fail(new InvalidMonitorInput({ message: "url: invalid" }))
      );
      const error = yield* service
        .update("m1", { name: "Renamed", public: true })
        .pipe(Effect.flip);
      assert.deepStrictEqual(writes, ["public=true"]);
      assert.strictEqual(error._tag, "Conflict");
      assert.include(error.message, "public was set to true");
      assert.include(error.message, "retry");
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  it.effect("a transport failure is a 503 naming the change", () =>
    Effect.gen(function* transportTest() {
      const { service, writes } = makeRacingService(() =>
        Effect.die(new Error("connection reset"))
      );
      const error = yield* service
        .update("m1", { name: "Renamed", public: true })
        .pipe(Effect.flip);
      assert.deepStrictEqual(writes, ["public=true"]);
      assert.strictEqual(error._tag, "Unavailable");
      assert.include(error.message, "public was set to true");
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  it.effect("an invalid patch is a 400 before public changes", () =>
    Effect.gen(function* invalidTest() {
      const { service, writes } = makeRacingService(() =>
        Effect.succeed(snapshot)
      );
      const error = yield* service
        .update("m1", { public: true, url: "ftp://example.com/" })
        .pipe(Effect.flip);
      assert.deepStrictEqual(writes, []);
      assert.strictEqual(error._tag, "BadRequest");
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );
});

const activity = (up: number, counted: number): RecentActivity => ({
  buckets: [{ at: t0, failures: counted - up, latencyMs: 120 }],
  counted,
  up,
  uptimePercent: counted === 0 ? null : (up / counted) * 100,
});

/** A Registry row for monitor `id` with the given summary overrides. */
const entryOf = (
  id: string,
  overrides: Partial<RegistryEntry["summary"]> = {},
  episodeId: string | null = null
): RegistryEntry => ({
  ...entry,
  id,
  key: id,
  summary: { ...entry.summary, ...overrides, name: id },
  watch: { episodeId, staleRuns: episodeId === null ? 0 : 2 },
});

describe(statusCounts, () => {
  it("counts a disabled monitor as paused, whatever its status", () => {
    assert.deepStrictEqual(
      statusCounts([
        entryOf("a", { status: "up" }),
        entryOf("b", { status: "up" }),
        entryOf("c", { status: "down" }),
        entryOf("d", { enabled: false, status: "down" }),
        entryOf("e", { status: "unknown" }),
      ]),
      { down: 1, paused: 1, unknown: 1, up: 2 }
    );
  });
});

describe(toOverview, () => {
  it("lists each monitor with its flags and recent activity", () => {
    const recent = activity(9, 10);
    const overview = toOverview(
      [
        { entry: entryOf("a", { status: "up" }), recent },
        { entry: entryOf("b", { status: "down" }, "watchdog-1"), recent: null },
      ],
      t0
    );
    assert.strictEqual(overview.generatedAt, t0);
    assert.deepStrictEqual(overview.counts, {
      down: 1,
      paused: 0,
      unknown: 0,
      up: 1,
    });
    assert.deepStrictEqual(
      overview.monitors.map((item) => [item.id, item.notChecked, item.recent]),
      [
        ["a", false, recent],
        ["b", true, null],
      ]
    );
    assert.strictEqual(overview.monitors[0]?.name, "a");
    assert.strictEqual(overview.monitors[0]?.managed, false);
  });
});

const episode: Episode = {
  id: "watchdog-1",
  intervalSeconds: 60,
  lastCheckedAt: t0,
  monitorId: "m1",
  monitorName: "Site",
  monitorUrl: "https://example.com/",
  resolution: null,
  resolvedAt: null,
  startedAt: t0 + 1000,
};

/**
 * A service over fake objects for the reads: `entries` in the Registry,
 * and each monitor's `recent` from `recentOf` (tracking concurrency).
 */
const makeReadService = (
  entries: readonly RegistryEntry[],
  recentOf: (id: string) => Effect.Effect<RecentActivity>
) => {
  const calls: { id: string; windowMs: number; buckets: number }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const registry: Pick<RegistryStub, "get" | "list" | "openEpisodes"> = {
    get: (id: string) =>
      Effect.succeed(entries.find((row) => row.id === id) ?? null),
    list: () => Effect.succeed(entries),
    openEpisodes: () => Effect.succeed([episode]),
  };
  const monitorOf = (id: string): Pick<MonitorStub, "recent" | "snapshot"> => ({
    recent: (windowMs: number, buckets: number) =>
      Effect.gen(function* recentStub() {
        calls.push({ buckets, id, windowMs });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        yield* Effect.yieldNow;
        return yield* recentOf(id);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlight -= 1;
          })
        )
      ),
    snapshot: () =>
      Effect.succeed({ ...snapshot, config: { ...config, id, key: id } }),
  });
  const service = makeMonitorService({
    devMode: false,
    // SAFETY: the reads only call `getByName` on the namespace, then
    // `recent` and `snapshot` on the stub; this double implements those.
    monitors: {
      getByName: (name: string) => monitorOf(name),
    } as MonitorServiceDeps["monitors"],
    quota: 10,
    // SAFETY: the reads only call `getByName` on the namespace, then
    // `get`, `list` and `openEpisodes` on the stub; this double
    // implements exactly those.
    registries: {
      getByName: (_name: string) => registry,
    } as MonitorServiceDeps["registries"],
  });
  return { calls, maxInFlight: () => maxInFlight, service };
};

describe("monitor reads for the dashboard", () => {
  it.effect("the overview reads every active monitor, bounded", () =>
    Effect.gen(function* overviewTest() {
      const entries = [
        ...Array.from({ length: 20 }, (_, index) => entryOf(`m${index}`)),
        { ...entryOf("creating"), lifecycle: "creating" as const },
      ];
      const { calls, maxInFlight, service } = makeReadService(entries, (id) =>
        id === "m3"
          ? Effect.die(new Error("object unavailable"))
          : Effect.succeed(activity(1, 1))
      );
      const overview = yield* service.overview({ buckets: 12, hours: 6 });
      assert.strictEqual(overview.monitors.length, 20);
      assert.isFalse(overview.monitors.some((item) => item.id === "creating"));
      assert.isNull(overview.monitors.find((item) => item.id === "m3")?.recent);
      assert.deepStrictEqual(
        overview.monitors.find((item) => item.id === "m4")?.recent,
        activity(1, 1)
      );
      assert.strictEqual(overview.counts.unknown, 20);
      assert.strictEqual(calls.length, 20);
      assert.deepStrictEqual(calls[0], {
        buckets: 12,
        id: "m0",
        windowMs: 6 * 3_600_000,
      });
      assert.isAtMost(maxInFlight(), overviewConcurrency);
      assert.isAbove(maxInFlight(), 1);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  it.effect("recent is a 404 for an unknown monitor", () =>
    Effect.gen(function* recentTest() {
      const { calls, service } = makeReadService([entryOf("m1")], () =>
        Effect.succeed(activity(1, 1))
      );
      const found = yield* service.recent("m1", { buckets: 48, hours: 24 });
      assert.deepStrictEqual(found, activity(1, 1));
      assert.deepStrictEqual(calls, [
        { buckets: 48, id: "m1", windowMs: 24 * 3_600_000 },
      ]);
      const error = yield* service
        .recent("nope", { buckets: 48, hours: 24 })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NotFound");
      assert.strictEqual(calls.length, 1);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  it.effect("get and list report an open watchdog episode", () =>
    Effect.gen(function* notCheckedTest() {
      const { service } = makeReadService(
        [entryOf("m1", {}, "watchdog-1"), entryOf("m2")],
        () => Effect.succeed(activity(1, 1))
      );
      assert.isTrue((yield* service.get("m1")).notChecked);
      assert.isFalse((yield* service.get("m2")).notChecked);
      assert.deepStrictEqual(
        (yield* service.list())
          .map(service.toListItem)
          .map((item) => [item.id, item.notChecked]),
        [
          ["m1", true],
          ["m2", false],
        ]
      );
      assert.deepStrictEqual(yield* service.openEpisodes(), [episode]);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );
});
