import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import type { RecentBucket } from "../../src/domain/history.ts";
import { overallStatus } from "../../src/domain/public-status.ts";
import { recentActivity } from "../../src/monitor/history.ts";
import type { BarDay } from "../../src/ui/charts.ts";
import {
  barLevel,
  sparkline,
  sparklinePath,
  uptimeBars,
} from "../../src/ui/charts.ts";
import {
  formatAgo,
  formatDuration,
  formatPercent,
  formatUtc,
} from "../../src/ui/format.ts";
import {
  channelCreateFromForm,
  channelPatchFromForm,
  monitorCreateFromForm,
  monitorPatchFromForm,
} from "../../src/ui/forms.ts";
import { statusPage } from "../../src/ui/status-page.ts";

const day = (
  uptimePercent: number | null,
  partial = false,
  name = "2026-09-01"
): BarDay => ({ day: name, partial, uptimePercent });

const bucket = (
  latencyMs: number | null,
  failures = 0,
  at = 0
): RecentBucket => ({ at, failures, latencyMs });

const count = (markup: string, needle: string) =>
  markup.split(needle).length - 1;

describe("uptime bars", () => {
  it("colours days by uptime, partial days grey, empty days blank", () => {
    assert.strictEqual(barLevel(null), "none");
    assert.strictEqual(barLevel(day(null)), "none");
    assert.strictEqual(barLevel(day(100)), "ok");
    assert.strictEqual(barLevel(day(99.5)), "ok");
    assert.strictEqual(barLevel(day(99.4)), "warn");
    assert.strictEqual(barLevel(day(95)), "warn");
    assert.strictEqual(barLevel(day(94.9)), "bad");
    // Partial wins over the percentage: too few samples to trust it.
    assert.strictEqual(barLevel(day(100, true)), "partial");
    assert.strictEqual(barLevel(day(12, true)), "partial");
    assert.strictEqual(barLevel(day(null, true)), "partial");
  });

  it("pads a young monitor's days on the left to the full width", () => {
    const markup = uptimeBars([day(100, false, "2026-09-27"), day(50)]).value;
    assert.strictEqual(count(markup, "<rect"), 90);
    assert.strictEqual(count(markup, 'class="bar-none"'), 88);
    assert.strictEqual(count(markup, 'class="bar-ok"'), 1);
    assert.strictEqual(count(markup, 'class="bar-bad"'), 1);
    // Oldest left, today (the last day) is the last bar.
    assert.isBelow(
      markup.indexOf("2026-09-27: 100%"),
      markup.indexOf("2026-09-01: 50.00%")
    );
    assert.include(markup, "No data");
  });

  it("keeps only the last `count` days", () => {
    const days = Array.from({ length: 120 }, (_, index) =>
      day(100, index === 119)
    );
    const markup = uptimeBars(days).value;
    assert.strictEqual(count(markup, "<rect"), 90);
    assert.strictEqual(count(markup, 'class="bar-partial"'), 1);
    assert.include(markup, "(partial)");
  });
});

describe("sparkline", () => {
  it("scales latency to the height and breaks at gaps", () => {
    const path = sparklinePath(
      [bucket(100), bucket(50), bucket(null), bucket(0)],
      30,
      24
    );
    // max 100 at the top (pad 2), 0 at the bottom (24 - 2).
    assert.strictEqual(path, "M0.0 2.0L10.0 12.0M30.0 22.0");
    assert.strictEqual(sparklinePath([bucket(null), bucket(null)]), "");
  });

  it("renders a placeholder without data and marks failures", () => {
    const empty = sparkline([bucket(null), bucket(null)]).value;
    assert.include(empty, "spark-empty");
    assert.include(empty, "No latency data");

    const withFailures = sparkline([
      bucket(10),
      bucket(null, 2),
      bucket(30),
    ]).value;
    assert.include(withFailures, "spark-line");
    assert.strictEqual(count(withFailures, "spark-fail"), 1);
    assert.include(withFailures, "Latency 10–30 ms");
  });

  it("assembles buckets, filling the empty ones", () => {
    const activity = recentActivity(1000, 100, 4, {
      buckets: [
        { bucket: 1, failures: 1, latencyMs: 12.6 },
        { bucket: 3, failures: null, latencyMs: null },
      ],
      counted: 4,
      up: 3,
    });
    assert.deepStrictEqual(activity, {
      buckets: [
        { at: 1000, failures: 0, latencyMs: null },
        { at: 1100, failures: 1, latencyMs: 13 },
        { at: 1200, failures: 0, latencyMs: null },
        { at: 1300, failures: 0, latencyMs: null },
      ],
      counted: 4,
      up: 3,
      uptimePercent: 75,
    });
    assert.isNull(
      recentActivity(0, 1, 1, { buckets: [], counted: 0, up: 0 }).uptimePercent
    );
  });
});

describe("formatting", () => {
  it("formats durations, ages and percentages", () => {
    assert.strictEqual(formatDuration(45_000), "45s");
    assert.strictEqual(formatDuration(252_000), "4m 12s");
    assert.strictEqual(formatDuration(3_600_000), "1h");
    assert.strictEqual(formatDuration(3_725_000), "1h 2m");
    assert.strictEqual(formatDuration(90_000_000), "1d 1h");
    const now = 1_000_000_000;
    assert.strictEqual(formatAgo(now - 1000, now), "just now");
    assert.strictEqual(formatAgo(now - 12_000, now), "12s ago");
    assert.strictEqual(formatAgo(now - 5 * 60_000, now), "5m ago");
    assert.strictEqual(formatAgo(now - 3 * 3_600_000, now), "3h ago");
    assert.strictEqual(formatPercent(null), "—");
    assert.strictEqual(formatPercent(100), "100%");
    // Never rounds up to 100%.
    assert.strictEqual(formatPercent(99.999), "99.99%");
    assert.strictEqual(
      formatUtc(Date.UTC(2026, 8, 28, 18, 40)),
      "2026-09-28 18:40 UTC"
    );
  });
});

const monitorForm = (
  extra: readonly (readonly [string, string])[] = []
): readonly (readonly [string, string])[] => [
  ["name", " API "],
  ["url", "https://example.com/health"],
  ["method", "HEAD"],
  ["expectedStatus", "204"],
  ["bodyContains", ""],
  ["intervalSeconds", "30"],
  ["timeoutSeconds", "2.5"],
  ["failureThreshold", "2"],
  ["successThreshold", "1"],
  ["channelMode", "all"],
  ...extra,
];

describe("forms", () => {
  it("maps the monitor form to API input", () => {
    const parsed = monitorCreateFromForm(
      monitorForm([
        ["enabled", "on"],
        ["public", "on"],
        ["key", "api"],
      ])
    );
    assert.deepStrictEqual(
      parsed,
      Result.succeed({
        bodyContains: null,
        channels: "all",
        enabled: true,
        expectedStatus: 204,
        failureThreshold: 2,
        intervalSeconds: 30,
        key: "api",
        method: "HEAD",
        name: "API",
        public: true,
        successThreshold: 1,
        timeoutMs: 2500,
        url: "https://example.com/health",
      })
    );
  });

  it("reads unchecked boxes as false and a channel list", () => {
    const parsed = monitorPatchFromForm(
      monitorForm([
        ["channelMode", "some"],
        ["channel", "a"],
        ["channel", "b"],
      ]).filter(([key, value]) => !(key === "channelMode" && value === "all"))
    );
    assert.isTrue(Result.isSuccess(parsed));
    if (Result.isSuccess(parsed)) {
      assert.strictEqual(parsed.success.enabled, false);
      assert.strictEqual(parsed.success.public, false);
      assert.deepStrictEqual(parsed.success.channels, ["a", "b"]);
    }
  });

  it("reports readable errors", () => {
    assert.deepStrictEqual(
      monitorCreateFromForm(
        monitorForm().map(([key, value]) =>
          key === "intervalSeconds" ? [key, "abc"] : [key, value]
        )
      ),
      Result.fail("Interval: Expected number")
    );
    assert.deepStrictEqual(
      monitorCreateFromForm(
        monitorForm().map(([key, value]) =>
          key === "timeoutSeconds" ? [key, "45"] : [key, value]
        )
      ),
      Result.fail("Timeout: must be between 1 and 30 seconds")
    );
    assert.deepStrictEqual(
      monitorCreateFromForm(
        monitorForm().map(([key, value]) =>
          key === "name" ? [key, ""] : [key, value]
        )
      ),
      Result.fail("Name: Expected a value with a length of at least 1")
    );
  });

  it("maps channel forms; an empty URL keeps the stored one", () => {
    assert.deepStrictEqual(
      channelCreateFromForm([
        ["name", "Ops"],
        ["kind", "slack"],
        ["url", "https://hooks.slack.com/x"],
        ["key", ""],
      ]),
      Result.succeed({
        kind: "slack",
        name: "Ops",
        url: "https://hooks.slack.com/x",
      })
    );
    assert.deepStrictEqual(
      channelPatchFromForm([
        ["name", "Ops"],
        ["kind", "discord"],
        ["url", ""],
      ]),
      Result.succeed({ kind: "discord", name: "Ops" })
    );
    assert.isTrue(
      Result.isFailure(
        channelCreateFromForm([
          ["name", "Ops"],
          ["kind", "pager"],
          ["url", "https://x.example"],
        ])
      )
    );
  });
});

describe("public status", () => {
  it("derives the overall status from the monitors", () => {
    assert.strictEqual(overallStatus([]), "operational");
    assert.strictEqual(
      overallStatus([{ status: "up" }, { status: "unknown" }]),
      "operational"
    );
    assert.strictEqual(
      overallStatus([{ status: "up" }, { status: "down" }]),
      "partial_outage"
    );
    assert.strictEqual(
      overallStatus([{ status: "down" }, { status: "paused" }]),
      "major_outage"
    );
  });

  it("renders the page with escaped names and no URLs", () => {
    const markup = statusPage({
      generatedAt: Date.UTC(2026, 8, 28),
      monitors: [
        {
          days: [day(100)],
          downSince: null,
          lastCheckedAt: null,
          name: "<API>",
          status: "up",
          uptimePercent: 100,
        },
        {
          days: [],
          downSince: Date.UTC(2026, 8, 27, 23),
          lastCheckedAt: null,
          name: "Web",
          status: "down",
          uptimePercent: null,
        },
      ],
      overall: "partial_outage",
    }).value;
    assert.include(markup, "&lt;API&gt;");
    assert.notInclude(markup, "<API>");
    assert.include(markup, "Partial outage");
    assert.include(markup, "Open incidents");
    assert.include(markup, "1h");
    assert.strictEqual(count(markup, 'class="status-monitor"'), 2);
  });
});
