import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import exampleConfig from "../../kanshi.config.ts";
import devConfig from "../../kanshi.dev.config.ts";
import { KanshiConfig, env } from "../../src/config.ts";
import type { ChannelView } from "../../src/domain/channel.ts";
import { hashUrl } from "../../src/domain/channel.ts";
import { resolveDesired } from "../../src/sync/desired.ts";
import type {
  Current,
  CurrentMonitor,
  Desired,
  DesiredChannel,
  DesiredMonitor,
  Step,
} from "../../src/sync/plan.ts";
import { diff, formatPlan, monitorSettingKeys } from "../../src/sync/plan.ts";

const desiredChannel = (
  key: string,
  overrides: Partial<DesiredChannel> = {}
): DesiredChannel => ({
  key,
  kind: "webhook",
  name: `Channel ${key}`,
  url: `https://hooks.example.com/${key}`,
  urlHash: `hash-${key}`,
  ...overrides,
});

const desiredMonitor = (
  key: string,
  overrides: Partial<DesiredMonitor> = {}
): DesiredMonitor => ({
  bodyContains: null,
  channels: "all",
  enabled: true,
  expectedStatus: "2xx",
  failureThreshold: 1,
  intervalSeconds: 60,
  key,
  method: "GET",
  name: `Monitor ${key}`,
  public: false,
  successThreshold: 1,
  timeoutMs: 10_000,
  url: `https://${key}.example.com/`,
  ...overrides,
});

/** The API's view of a channel that matches `desiredChannel(key)`. */
const channelView = (
  key: string,
  overrides: Partial<ChannelView> = {}
): ChannelView => ({
  createdAt: 0,
  id: `ch-${key}`,
  key,
  kind: "webhook",
  managed: true,
  maskedUrl: "https://hooks.example.com/****",
  name: `Channel ${key}`,
  updatedAt: 0,
  urlHash: `hash-${key}`,
  ...overrides,
});

/** The API's view of a monitor that matches `desiredMonitor(key)`. */
const currentMonitor = (
  key: string,
  overrides: Partial<DesiredMonitor> & {
    readonly channelIds?: CurrentMonitor["channels"];
    readonly managed?: boolean;
  } = {}
): CurrentMonitor => {
  const { channelIds, managed, ...settings } = overrides;
  const monitor = desiredMonitor(key, settings);
  return {
    channels: channelIds ?? "all",
    id: `mon-${key}`,
    key,
    managed: managed ?? true,
    name: monitor.name,
    settings: Object.fromEntries(
      monitorSettingKeys.map((field) => [field, monitor[field]])
    ) as unknown as NonNullable<CurrentMonitor["settings"]>,
  };
};

const empty: Current = { channels: [], monitors: [] };
const tags = (steps: readonly Step[]) =>
  steps.map((step) => {
    switch (step._tag) {
      case "CreateChannel": {
        return `${step._tag} ${step.channel.key}`;
      }
      case "CreateMonitor": {
        return `${step._tag} ${step.monitor.key}`;
      }
      default: {
        return `${step._tag} ${step.key}`;
      }
    }
  });

describe("config diff", () => {
  it("creates everything on an empty Worker, channels first", () => {
    const desired: Desired = {
      channels: [desiredChannel("a")],
      monitors: [desiredMonitor("m", { channels: ["a"] })],
    };
    const plan = diff(desired, empty);
    assert.deepStrictEqual(plan.errors, []);
    assert.deepStrictEqual(tags(plan.steps), [
      "CreateChannel a",
      "CreateMonitor m",
    ]);
  });

  it("is a no-op when everything matches", () => {
    const desired: Desired = {
      channels: [desiredChannel("a"), desiredChannel("b")],
      monitors: [
        desiredMonitor("m", { channels: ["b", "a"] }),
        desiredMonitor("n"),
      ],
    };
    const current: Current = {
      channels: [channelView("a"), channelView("b")],
      monitors: [
        currentMonitor("m", { channelIds: ["ch-a", "ch-b"] }),
        currentMonitor("n"),
      ],
    };
    const plan = diff(desired, current);
    assert.deepStrictEqual(plan, { errors: [], steps: [] });
    assert.strictEqual(formatPlan(plan), "No changes.");
  });

  it("updates only the changed monitor fields", () => {
    const desired: Desired = {
      channels: [],
      monitors: [
        desiredMonitor("m", {
          expectedStatus: "200",
          intervalSeconds: 30,
          public: true,
        }),
      ],
    };
    const current: Current = { channels: [], monitors: [currentMonitor("m")] };
    const plan = diff(desired, current);
    assert.deepStrictEqual(plan.steps, [
      {
        _tag: "UpdateMonitor",
        changes: ["expectedStatus", "intervalSeconds", "public"],
        id: "mon-m",
        key: "m",
        patch: { expectedStatus: "200", intervalSeconds: 30, public: true },
      },
    ]);
  });

  it("resets a field removed from the config to its default", () => {
    const desired: Desired = { channels: [], monitors: [desiredMonitor("m")] };
    const current: Current = {
      channels: [],
      monitors: [currentMonitor("m", { bodyContains: "ok", enabled: false })],
    };
    const [step] = diff(desired, current).steps;
    assert.deepStrictEqual(step?._tag === "UpdateMonitor" && step.patch, {
      bodyContains: null,
      enabled: true,
    });
  });

  it("updates a channel whose URL hash changed, sending the new URL", () => {
    const desired: Desired = {
      channels: [
        desiredChannel("a", {
          url: "https://hooks.example.com/rotated",
          urlHash: "hash-rotated",
        }),
      ],
      monitors: [],
    };
    const current: Current = { channels: [channelView("a")], monitors: [] };
    assert.deepStrictEqual(diff(desired, current).steps, [
      {
        _tag: "UpdateChannel",
        changes: ["url"],
        id: "ch-a",
        key: "a",
        patch: { url: "https://hooks.example.com/rotated" },
      },
    ]);
  });

  it("updates channel name and kind", () => {
    const desired: Desired = {
      channels: [desiredChannel("a", { kind: "slack", name: "Renamed" })],
      monitors: [],
    };
    const current: Current = { channels: [channelView("a")], monitors: [] };
    const [step] = diff(desired, current).steps;
    assert.deepStrictEqual(step?._tag === "UpdateChannel" && step.changes, [
      "kind",
      "name",
    ]);
  });

  it("compares monitor channels by key, whatever the order", () => {
    const current: Current = {
      channels: [channelView("a"), channelView("b")],
      monitors: [currentMonitor("m", { channelIds: ["ch-b", "ch-a"] })],
    };
    const same = diff(
      {
        channels: [desiredChannel("a"), desiredChannel("b")],
        monitors: [desiredMonitor("m", { channels: ["a", "b"] })],
      },
      current
    );
    assert.deepStrictEqual(same.steps, []);

    const narrowed = diff(
      {
        channels: [desiredChannel("a"), desiredChannel("b")],
        monitors: [desiredMonitor("m", { channels: ["a"] })],
      },
      current
    );
    assert.deepStrictEqual(narrowed.steps, [
      {
        _tag: "UpdateMonitor",
        changes: ["channels"],
        id: "mon-m",
        key: "m",
        patch: { channels: ["a"] },
      },
    ]);
  });

  it("treats a dangling channel id as a change", () => {
    const current: Current = {
      channels: [channelView("a")],
      monitors: [currentMonitor("m", { channelIds: ["ch-a", "gone"] })],
    };
    const plan = diff(
      {
        channels: [desiredChannel("a")],
        monitors: [desiredMonitor("m", { channels: ["a"] })],
      },
      current
    );
    assert.deepStrictEqual(tags(plan.steps), ["UpdateMonitor m"]);
  });

  it("lets monitors use dashboard-created channels by key", () => {
    const current: Current = {
      channels: [channelView("manual", { id: "ch-manual", managed: false })],
      monitors: [],
    };
    const plan = diff(
      {
        channels: [],
        monitors: [desiredMonitor("m", { channels: ["manual"] })],
      },
      current
    );
    assert.deepStrictEqual(plan.errors, []);
    assert.deepStrictEqual(tags(plan.steps), ["CreateMonitor m"]);
  });

  it("rejects unknown channel keys, including managed ones being deleted", () => {
    const current: Current = {
      channels: [channelView("old")],
      monitors: [],
    };
    const plan = diff(
      {
        channels: [],
        monitors: [desiredMonitor("m", { channels: ["old", "nope"] })],
      },
      current
    );
    assert.deepStrictEqual(plan.errors, [
      'monitor "m": unknown channel key(s) "old", "nope"',
    ]);
  });

  it("deletes managed resources missing from the config, monitors first", () => {
    const current: Current = {
      channels: [channelView("a"), channelView("keep")],
      monitors: [currentMonitor("m"), currentMonitor("stay")],
    };
    const plan = diff(
      {
        channels: [desiredChannel("keep")],
        monitors: [desiredMonitor("stay")],
      },
      current
    );
    assert.deepStrictEqual(tags(plan.steps), [
      "DeleteMonitor m",
      "DeleteChannel a",
    ]);
  });

  it("orders creates and updates before deletes", () => {
    const current: Current = {
      channels: [channelView("old"), channelView("b", { name: "stale" })],
      monitors: [currentMonitor("gone"), currentMonitor("m", { name: "x" })],
    };
    const plan = diff(
      {
        channels: [desiredChannel("new"), desiredChannel("b")],
        monitors: [desiredMonitor("m"), desiredMonitor("fresh")],
      },
      current
    );
    assert.deepStrictEqual(tags(plan.steps), [
      "CreateChannel new",
      "UpdateChannel b",
      "UpdateMonitor m",
      "CreateMonitor fresh",
      "DeleteMonitor gone",
      "DeleteChannel old",
    ]);
  });

  it("leaves unmanaged resources alone", () => {
    const current: Current = {
      channels: [channelView("manual", { managed: false })],
      monitors: [
        { id: "mon-manual", key: "manual", managed: false, name: "Manual" },
      ],
    };
    const plan = diff({ channels: [], monitors: [] }, current);
    assert.deepStrictEqual(plan, { errors: [], steps: [] });
  });

  it("refuses a key that belongs to an unmanaged resource", () => {
    const current: Current = {
      channels: [channelView("a", { managed: false })],
      monitors: [currentMonitor("m", { managed: false })],
    };
    const plan = diff(
      {
        channels: [desiredChannel("a", { name: "changed" })],
        monitors: [desiredMonitor("m", { name: "changed" })],
      },
      current
    );
    assert.strictEqual(plan.errors.length, 2);
    assert.include(plan.errors[0], 'channel "a" exists but was not created');
    assert.include(plan.errors[1], 'monitor "m" exists but was not created');
    assert.include(formatPlan(plan), "nothing was changed");
  });

  it("adopts unmanaged resources with --adopt", () => {
    const current: Current = {
      channels: [channelView("a", { managed: false })],
      monitors: [currentMonitor("m", { managed: false })],
    };
    const plan = diff(
      { channels: [desiredChannel("a")], monitors: [desiredMonitor("m")] },
      current,
      { adopt: true }
    );
    assert.deepStrictEqual(plan.errors, []);
    assert.deepStrictEqual(
      plan.steps.map((step) =>
        step._tag === "UpdateChannel" || step._tag === "UpdateMonitor"
          ? [step._tag, step.changes, step.patch]
          : step._tag
      ),
      [
        ["UpdateChannel", ["managed"], { managed: true }],
        ["UpdateMonitor", ["managed"], { managed: true }],
      ]
    );
  });

  it("rejects duplicate keys in the config", () => {
    const plan = diff(
      {
        channels: [desiredChannel("a"), desiredChannel("a")],
        monitors: [desiredMonitor("m"), desiredMonitor("m")],
      },
      empty
    );
    assert.deepStrictEqual(plan.errors, [
      'channel key "a" is used more than once in the config',
      'monitor key "m" is used more than once in the config',
    ]);
  });

  it("formats the plan", () => {
    const plan = diff(
      {
        channels: [desiredChannel("a")],
        monitors: [desiredMonitor("m")],
      },
      { channels: [channelView("z")], monitors: [] }
    );
    assert.strictEqual(
      formatPlan(plan),
      [
        "  + channel a (webhook)",
        "  + monitor m (https://m.example.com/)",
        "  - channel z (Channel z)",
        "2 to create, 0 to update, 1 to delete.",
      ].join("\n")
    );
  });
});

describe("config resolution", () => {
  it.effect("reads env vars, normalises and hashes like the Worker", () =>
    Effect.gen(function* resolveTest() {
      const { desired, errors } = yield* resolveDesired(
        {
          channels: [
            {
              key: "slack",
              kind: "slack",
              name: "Slack",
              url: env("SLACK_URL"),
            },
            {
              key: "lit",
              kind: "webhook",
              name: "Literal",
              url: "hooks.example.com/x",
            },
          ],
          monitors: [
            {
              channels: ["slack", "slack", "lit"],
              expectedStatus: "200, 2XX",
              key: "m",
              name: "M",
              url: "Example.com",
            },
          ],
        },
        { SLACK_URL: " https://hooks.slack.com/services/T/B/secret " }
      );
      assert.deepStrictEqual(errors, []);
      const [slack, literal] = desired.channels;
      assert.strictEqual(
        slack?.url,
        "https://hooks.slack.com/services/T/B/secret"
      );
      assert.strictEqual(slack?.urlHash, yield* hashUrl(slack?.url ?? ""));
      assert.strictEqual(literal?.url, "https://hooks.example.com/x");
      assert.deepStrictEqual(desired.monitors, [
        desiredMonitor("m", {
          channels: ["slack", "lit"],
          expectedStatus: "200,2xx",
          name: "M",
          url: "https://example.com/",
        }),
      ]);
    })
  );

  it.effect("reports every problem", () =>
    Effect.gen(function* errorsTest() {
      const { errors } = yield* resolveDesired(
        {
          channels: [
            { key: "a", kind: "slack", name: "A", url: env("MISSING") },
            { key: "b", kind: "slack", name: "B", url: "http://example.com" },
          ],
          monitors: [
            {
              expectedStatus: "abc",
              key: "m",
              name: "M",
              url: "https://10.0.0.1",
            },
          ],
        },
        {}
      );
      assert.deepStrictEqual(errors, [
        'channel "a": environment variable MISSING is not set',
        'channel "b": url: alert channel URLs must use https',
        'monitor "m": url: private and reserved IP addresses are not allowed',
        'monitor "m": expectedStatus: invalid expected status "abc": use a code like 200 or a class like 2xx',
      ]);
    })
  );

  it("accepts the example and dev configs", () => {
    for (const config of [exampleConfig, devConfig]) {
      assert.deepStrictEqual(
        Schema.decodeUnknownSync(KanshiConfig)(config, {
          onExcessProperty: "error",
        }),
        config
      );
    }
  });

  it("rejects invalid keys and unknown fields", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(KanshiConfig)({
        monitors: [{ key: "Bad Key!", name: "x", url: "https://x.com" }],
      })
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(KanshiConfig)(
        {
          monitors: [{ key: "k", name: "x", nmae: "y", url: "https://x.com" }],
        },
        { onExcessProperty: "error" }
      )
    );
  });
});
