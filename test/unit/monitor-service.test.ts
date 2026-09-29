import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";

import type {
  MonitorConfig,
  MonitorSnapshot,
} from "../../src/domain/monitor.ts";
import { summaryOf } from "../../src/domain/monitor.ts";
import { initialState } from "../../src/monitor/cycle.ts";
import { InvalidMonitorInput } from "../../src/monitor/errors.ts";
import type { RegistryEntry } from "../../src/registry/registry.ts";
import type { MonitorServiceDeps } from "../../src/service/monitors.ts";
import { makeMonitorService } from "../../src/service/monitors.ts";

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
