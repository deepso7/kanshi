import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";

import type { UptimeReport } from "../../src/domain/history.ts";
import type { MonitorConfig } from "../../src/domain/monitor.ts";
import { summaryOf } from "../../src/domain/monitor.ts";
import { initialState } from "../../src/monitor/cycle.ts";
import type { RegistryEntry } from "../../src/registry/registry.ts";
import type { StatusDeps } from "../../src/service/status.ts";
import { makeStatusService, publicRef } from "../../src/service/status.ts";

const t0 = 1_000_000;

const config = (id: string): MonitorConfig => ({
  bodyContains: null,
  channels: "all",
  createdAt: t0,
  enabled: true,
  expectedStatus: "2xx",
  failureThreshold: 1,
  generation: 0,
  id,
  intervalSeconds: 60,
  method: "GET",
  // Names need not be unique.
  name: "Website",
  successThreshold: 1,
  timeoutMs: 10_000,
  updatedAt: t0,
  url: `https://example.com/${id}?secret=s3cret`,
});

const entry = (id: string, isPublic: boolean): RegistryEntry => ({
  createdAt: t0,
  id,
  lifecycle: "active",
  opId: "op1",
  public: isPublic,
  summary: summaryOf(config(id), initialState(t0)),
  summaryRevision: 0,
  updatedAt: t0,
  watch: { episodeId: null },
});

const report: UptimeReport = {
  counted: 10,
  days: [
    {
      counted: 10,
      day: "2026-09-28",
      down: 1,
      expected: 10,
      live: true,
      p50: 100,
      p95: 200,
      partial: false,
      up: 9,
      uptimePercent: 90,
    },
  ],
  expected: 10,
  up: 9,
  uptimePercent: 90,
};

type RegistryStub = ReturnType<StatusDeps["registries"]["getByName"]>;
type MonitorStub = ReturnType<StatusDeps["monitors"]["getByName"]>;

const ids = [
  "3f1c6a7e-0d4b-4f7a-9d1e-2b8c5a6e7f01",
  "9a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "private-0000-4000-8000-000000000000",
];

const service = () => {
  const registry: Pick<RegistryStub, "list"> = {
    list: () =>
      Effect.succeed([
        entry(ids[0] ?? "", true),
        entry(ids[1] ?? "", true),
        entry(ids[2] ?? "", false),
      ]),
  };
  const monitor: Pick<MonitorStub, "incidents" | "uptime"> = {
    incidents: () => Effect.succeed([]),
    uptime: () => Effect.succeed(report),
  };
  return makeStatusService({
    cache: { get: () => Effect.succeed(null), set: () => Effect.void },
    // SAFETY: the public status only calls `getByName`, then `incidents`
    // and `uptime` on the stub; this double implements exactly those.
    monitors: {
      getByName: (_name: string) => monitor,
    } as StatusDeps["monitors"],
    // SAFETY: the public status only calls `getByName`, then `list` on the
    // stub; this double implements exactly that.
    registries: {
      getByName: (_name: string) => registry,
    } as StatusDeps["registries"],
  });
};

describe(publicRef, () => {
  it.effect("is stable, short, and does not contain the id", () =>
    Effect.gen(function* refTest() {
      const id = ids[0] ?? "";
      const ref = yield* publicRef(id);
      assert.match(ref, /^[0-9a-f]{16}$/u);
      assert.strictEqual(yield* publicRef(id), ref);
      assert.notStrictEqual(yield* publicRef(ids[1] ?? ""), ref);
      for (const part of id.split("-")) {
        assert.notInclude(ref, part);
      }
    })
  );
});

describe("public status", () => {
  it.effect("gives same-named monitors distinct refs, never ids or URLs", () =>
    Effect.gen(function* publicStatusTest() {
      const status = yield* service().publicStatus();
      assert.deepStrictEqual(
        status.monitors.map((monitor) => monitor.name),
        ["Website", "Website"]
      );
      const refs = status.monitors.map((monitor) => monitor.ref);
      assert.strictEqual(new Set(refs).size, 2);
      assert.deepStrictEqual(refs, [
        yield* publicRef(ids[0] ?? ""),
        yield* publicRef(ids[1] ?? ""),
      ]);
      const json = JSON.stringify(status);
      for (const id of ids) {
        assert.notInclude(json, id);
      }
      assert.notInclude(json, "example.com");
      assert.notInclude(json, "s3cret");
      assert.deepStrictEqual(status.monitors[0]?.days, [
        {
          counted: 10,
          day: "2026-09-28",
          partial: false,
          up: 9,
          uptimePercent: 90,
        },
      ]);
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );
});
