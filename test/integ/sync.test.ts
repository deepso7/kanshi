// Integration test for config sync (`kanshi sync`) against the local
// stack: create, a re-run is a no-op, changes (channel URL, monitor fields
// and channel references), a dashboard edit reverted, deletes, key
// collisions with dashboard-created resources and --adopt. Run with
// `pnpm test:integ`.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import type { MonitorListItem, MonitorResponse } from "../../src/api/spec.ts";
import type { KanshiConfig } from "../../src/config.ts";
import { env } from "../../src/config.ts";
import type { ChannelView } from "../../src/domain/channel.ts";
import { hashUrl } from "../../src/domain/channel.ts";
import type { Step } from "../../src/sync/plan.ts";
import type { SyncOptions } from "../../src/sync/sync.ts";
import { sync } from "../../src/sync/sync.ts";
import { apiToken } from "./alchemy.run.ts";
import { setup } from "./harness.ts";

const { create, send, stack, test } = setup("integ-sync");

const baseUrl = stack.pipe(Effect.map(({ url }) => url));

const describeSteps = (steps: readonly Step[]) =>
  steps.map((step) => {
    switch (step._tag) {
      case "CreateChannel": {
        return `${step._tag} ${step.channel.key}`;
      }
      case "CreateMonitor": {
        return `${step._tag} ${step.monitor.key}`;
      }
      case "UpdateChannel":
      case "UpdateMonitor": {
        return `${step._tag} ${step.key}: ${step.changes.join(",")}`;
      }
      default: {
        return `${step._tag} ${step.key}`;
      }
    }
  });

const runSync = (
  config: KanshiConfig,
  options: Partial<Pick<SyncOptions, "adopt" | "dryRun" | "environment">> = {}
) =>
  Effect.gen(function* runSyncEffect() {
    const url = yield* baseUrl;
    const result = yield* sync({
      baseUrl: url,
      config,
      environment: options.environment ?? {},
      log: () => {},
      token: apiToken,
      ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    return { ...result, steps: describeSteps(result.plan.steps) };
  });

const monitorsByKey = send("GET", "/api/monitors").pipe(
  Effect.map(
    (reply) =>
      new Map(
        (reply.body as readonly MonitorListItem[]).map(
          (item) => [item.key, item] as const
        )
      )
  )
);

const channelsByKey = send("GET", "/api/channels").pipe(
  Effect.map(
    (reply) =>
      new Map(
        (reply.body as readonly ChannelView[]).map(
          (item) => [item.key, item] as const
        )
      )
  )
);

const monitorByKey = (key: string) =>
  Effect.gen(function* monitorByKeyEffect() {
    const item = (yield* monitorsByKey).get(key);
    expect(item).toBeDefined();
    const reply = yield* send("GET", `/api/monitors/${item?.id}`);
    expect(reply.status).toBe(200);
    return reply.body as MonitorResponse;
  });

test(
  "sync creates, is idempotent, updates, reverts dashboard edits and deletes managed resources only",
  Effect.gen(function* syncTest() {
    const url = yield* baseUrl;
    const hookV1 = `${url}/_dev/webhook?as=sync-v1`;
    const hookV2 = `${url}/_dev/webhook?as=sync-v2`;

    // Dashboard-created (unmanaged) resources.
    const hand = yield* create({
      intervalSeconds: 30,
      key: "hand",
      name: "By hand",
      url: `${url}/_dev/target`,
    });
    expect(hand.managed).toBe(false);
    const handHook = yield* send("POST", "/api/channels", {
      body: {
        key: "hand-hook",
        kind: "webhook",
        name: "By hand",
        url: `${url}/_dev/webhook?as=hand`,
      },
    });
    expect(handHook.status).toBe(201);

    const v1: KanshiConfig = {
      channels: [
        {
          key: "sync-hook",
          kind: "webhook",
          name: "Sync hook",
          url: env("SYNC_HOOK_URL"),
        },
        {
          key: "sync-slack",
          kind: "slack",
          name: "Sync Slack",
          url: `${url}/_dev/webhook?as=sync-slack`,
        },
      ],
      monitors: [
        {
          channels: ["sync-hook"],
          intervalSeconds: 30,
          key: "sync-up",
          name: "Sync up",
          url: `${url}/_dev/target`,
        },
        {
          expectedStatus: 204,
          key: "sync-all",
          name: "Sync all channels",
          public: true,
          url: `${url}/_dev/target?status=204`,
        },
      ],
    };
    const envV1 = { SYNC_HOOK_URL: hookV1 };

    // Create: channels first, then monitors.
    const created = yield* runSync(v1, { environment: envV1 });
    expect(created.steps).toEqual([
      "CreateChannel sync-hook",
      "CreateChannel sync-slack",
      "CreateMonitor sync-up",
      "CreateMonitor sync-all",
    ]);
    expect(created.applied).toBe(4);
    const channels = yield* channelsByKey;
    const syncHook = channels.get("sync-hook");
    expect(syncHook?.managed).toBe(true);
    expect(syncHook?.urlHash).toBe(yield* hashUrl(hookV1));
    expect(channels.get("hand-hook")?.managed).toBe(false);
    const syncUp = yield* monitorByKey("sync-up");
    expect(syncUp.managed).toBe(true);
    expect(syncUp.channels).toEqual([syncHook?.id ?? ""]);
    const syncAll = yield* monitorByKey("sync-all");
    expect(syncAll).toMatchObject({
      channels: "all",
      expectedStatus: "204",
      intervalSeconds: 60,
      managed: true,
      public: true,
    });
    expect((yield* monitorsByKey).get("sync-all")?.managed).toBe(true);

    // Re-run: nothing to do.
    const again = yield* runSync(v1, { environment: envV1 });
    expect(again.steps).toEqual([]);
    expect(again.applied).toBe(0);

    // Change: rotated channel URL, interval, and a dashboard channel used
    // by key. A dry run plans but changes nothing.
    const v2: KanshiConfig = {
      ...v1,
      monitors: [
        {
          channels: ["sync-hook", "hand-hook"],
          intervalSeconds: 60,
          key: "sync-up",
          name: "Sync up",
          url: `${url}/_dev/target`,
        },
        ...(v1.monitors ?? []).slice(1),
      ],
    };
    const envV2 = { SYNC_HOOK_URL: hookV2 };
    const expectedV2 = [
      "UpdateChannel sync-hook: url",
      "UpdateMonitor sync-up: intervalSeconds,channels",
    ];
    const dry = yield* runSync(v2, { dryRun: true, environment: envV2 });
    expect(dry.steps).toEqual(expectedV2);
    expect(dry.applied).toBe(0);
    expect((yield* monitorByKey("sync-up")).intervalSeconds).toBe(30);

    const changed = yield* runSync(v2, { environment: envV2 });
    expect(changed.steps).toEqual(expectedV2);
    expect((yield* channelsByKey).get("sync-hook")?.urlHash).toBe(
      yield* hashUrl(hookV2)
    );
    const syncUpV2 = yield* monitorByKey("sync-up");
    expect(syncUpV2.intervalSeconds).toBe(60);
    expect(syncUpV2.channels).toEqual([
      syncHook?.id ?? "",
      channels.get("hand-hook")?.id ?? "",
    ]);
    expect((yield* runSync(v2, { environment: envV2 })).steps).toEqual([]);

    // A dashboard edit of a managed monitor is reverted by the next sync.
    const edited = yield* send("PATCH", `/api/monitors/${syncAll.id}`, {
      body: { enabled: false, name: "Edited in the dashboard" },
    });
    expect(edited.status).toBe(200);
    const reverted = yield* runSync(v2, { environment: envV2 });
    expect(reverted.steps).toEqual(["UpdateMonitor sync-all: name,enabled"]);
    expect(yield* monitorByKey("sync-all")).toMatchObject({
      enabled: true,
      name: "Sync all channels",
    });

    // Delete: removed from the config -> deleted, monitors before
    // channels; the dashboard's resources stay.
    const v3: KanshiConfig = {
      channels: (v2.channels ?? []).slice(0, 1),
      monitors: (v2.monitors ?? []).slice(0, 1),
    };
    const deleted = yield* runSync(v3, { environment: envV2 });
    expect(deleted.steps).toEqual([
      "DeleteMonitor sync-all",
      "DeleteChannel sync-slack",
    ]);
    const afterDelete = yield* monitorsByKey;
    expect([...afterDelete.keys()].toSorted()).toEqual(["hand", "sync-up"]);
    expect([...(yield* channelsByKey).keys()].toSorted()).toEqual([
      "hand-hook",
      "sync-hook",
    ]);

    // A key owned by a dashboard-created monitor is an error and nothing
    // is applied, even the valid parts of the config.
    const v4: KanshiConfig = {
      channels: v3.channels ?? [],
      monitors: [
        ...(v3.monitors ?? []),
        {
          intervalSeconds: 30,
          key: "hand",
          name: "Now from config",
          url: `${url}/_dev/target`,
        },
        {
          key: "sync-new",
          name: "New",
          url: `${url}/_dev/target`,
        },
      ],
    };
    const collision = yield* runSync(v4, { environment: envV2 }).pipe(
      Effect.flip
    );
    expect(collision._tag).toBe("SyncError");
    expect(collision.message).toContain(
      'monitor "hand" exists but was not created by config sync'
    );
    expect(afterDelete.size).toBe((yield* monitorsByKey).size);

    // --adopt takes it over; then it is managed like the rest.
    const adopted = yield* runSync(v4, { adopt: true, environment: envV2 });
    expect(adopted.steps).toEqual([
      "UpdateMonitor hand: managed,name",
      "CreateMonitor sync-new",
    ]);
    expect((yield* monitorsByKey).get("hand")?.managed).toBe(true);
    expect((yield* monitorByKey("hand")).name).toBe("Now from config");

    // An empty config deletes every managed resource and nothing else.
    const emptied = yield* runSync({}, { environment: envV2 });
    // Monitors come in the Registry's list order; channels go last.
    expect(emptied.steps.slice(0, 3).toSorted()).toEqual([
      "DeleteMonitor hand",
      "DeleteMonitor sync-new",
      "DeleteMonitor sync-up",
    ]);
    expect(emptied.steps.slice(3)).toEqual(["DeleteChannel sync-hook"]);
    expect([...(yield* monitorsByKey).keys()]).toEqual([]);
    expect([...(yield* channelsByKey).keys()]).toEqual(["hand-hook"]);
  }),
  { timeout: 60_000 }
);

test(
  "sync reports config errors before touching anything",
  Effect.gen(function* errorsTest() {
    const url = yield* baseUrl;
    const failure = yield* runSync({
      channels: [
        { key: "a", kind: "slack", name: "A", url: env("NOT_SET_ANYWHERE") },
      ],
      monitors: [{ key: "m", name: "M", url: `${url}/_dev/target` }],
    }).pipe(Effect.flip);
    expect(failure.message).toContain(
      "environment variable NOT_SET_ANYWHERE is not set"
    );
    expect((yield* monitorsByKey).has("m")).toBe(false);

    const unauthorized = yield* sync({
      baseUrl: url,
      config: {},
      environment: {},
      log: () => {},
      token: "wrong",
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.flip);
    expect(unauthorized.message).toContain("401");
  })
);
