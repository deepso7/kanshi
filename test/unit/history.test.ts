import { assert, describe, it } from "@effect/vitest";

import { uptimeOfLastDays, uptimePercent } from "../../src/domain/history.ts";
import type { EnabledPeriod, Sample } from "../../src/monitor/history.ts";
import {
  addDays,
  checksPruneBefore,
  dayMs,
  dayOf,
  dayStart,
  daysToRollUp,
  expectedSamples,
  incidentsPruneBefore,
  isPartial,
  maintenanceOffsetMs,
  nextMaintenanceTime,
  percentile,
  periodChange,
  recentActivity,
  reportDays,
  rollupDay,
  uptimeDay,
  uptimeReport,
} from "../../src/monitor/history.ts";

const day = "2026-09-20";
const midnight = Date.parse("2026-09-20T00:00:00Z");
const hour = 60 * 60 * 1000;

const ok = (latencyMs: number): Sample => ({ latencyMs, ok: true });
const failed: Sample = { latencyMs: 10_000, ok: false };

describe("days", () => {
  it("are UTC calendar days", () => {
    assert.strictEqual(dayOf(midnight), day);
    assert.strictEqual(dayOf(midnight - 1), "2026-09-19");
    assert.strictEqual(dayStart(day), midnight);
    assert.strictEqual(addDays(day, 1), "2026-09-21");
    assert.strictEqual(addDays("2026-12-31", 1), "2027-01-01");
    assert.strictEqual(addDays(day, -20), "2026-08-31");
  });

  it("maintenance runs shortly after the next UTC midnight", () => {
    assert.strictEqual(
      nextMaintenanceTime(midnight + 10 * hour),
      midnight + dayMs + maintenanceOffsetMs
    );
    assert.strictEqual(
      nextMaintenanceTime(midnight),
      midnight + maintenanceOffsetMs
    );
    // Strictly after now, so a run never re-arms for itself.
    assert.strictEqual(
      nextMaintenanceTime(midnight + maintenanceOffsetMs),
      midnight + dayMs + maintenanceOffsetMs
    );
  });
});

describe("percentiles", () => {
  it("use the nearest rank", () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.strictEqual(percentile(sorted, 0.5), 50);
    assert.strictEqual(percentile(sorted, 0.95), 95);
    assert.strictEqual(percentile([7], 0.5), 7);
    assert.strictEqual(percentile([7], 0.95), 7);
    assert.strictEqual(percentile([1, 2, 3], 0.5), 2);
    assert.strictEqual(percentile([1, 2, 3, 4], 0.5), 2);
    assert.isNull(percentile([], 0.5));
  });
});

describe("expected samples", () => {
  it("a monitor enabled all day at 60s expects 1440", () => {
    const periods: EnabledPeriod[] = [
      { endedAt: null, intervalSeconds: 60, startedAt: midnight - dayMs },
    ];
    assert.strictEqual(
      expectedSamples(periods, midnight, midnight + dayMs),
      1440
    );
  });

  it("counts only enabled time, across disable/enable and interval edits", () => {
    const periods: EnabledPeriod[] = [
      // created at 06:00 with 60s, disabled at 12:00
      {
        endedAt: midnight + 12 * hour,
        intervalSeconds: 60,
        startedAt: midnight + 6 * hour,
      },
      // re-enabled at 18:00 with 60s, interval set to 300s at 21:00
      {
        endedAt: midnight + 21 * hour,
        intervalSeconds: 60,
        startedAt: midnight + 18 * hour,
      },
      { endedAt: null, intervalSeconds: 300, startedAt: midnight + 21 * hour },
    ];
    assert.strictEqual(
      expectedSamples(periods, midnight, midnight + dayMs),
      6 * 60 + 3 * 60 + 3 * 12
    );
  });

  it("splits a period across day boundaries", () => {
    const periods: EnabledPeriod[] = [
      {
        endedAt: midnight + 2 * hour,
        intervalSeconds: 60,
        startedAt: midnight - 3 * hour,
      },
    ];
    assert.strictEqual(
      expectedSamples(periods, midnight - dayMs, midnight),
      180
    );
    assert.strictEqual(
      expectedSamples(periods, midnight, midnight + dayMs),
      120
    );
    assert.strictEqual(
      expectedSamples(periods, midnight + dayMs, midnight + 2 * dayMs),
      0
    );
  });

  it("keeps fractions to two decimals", () => {
    const periods: EnabledPeriod[] = [
      { endedAt: midnight + 100_000, intervalSeconds: 60, startedAt: midnight },
    ];
    assert.strictEqual(
      expectedSamples(periods, midnight, midnight + dayMs),
      1.67
    );
  });
});

describe("period changes", () => {
  const on = { enabled: true, intervalSeconds: 60 };
  const off = { enabled: false, intervalSeconds: 60 };

  it("create opens a period only when enabled", () => {
    assert.deepStrictEqual(periodChange(null, on), {
      close: false,
      open: { intervalSeconds: 60 },
    });
    assert.deepStrictEqual(periodChange(null, off), {
      close: false,
      open: null,
    });
  });

  it("disable closes, enable opens", () => {
    assert.deepStrictEqual(periodChange(on, off), { close: true, open: null });
    assert.deepStrictEqual(periodChange(off, on), {
      close: false,
      open: { intervalSeconds: 60 },
    });
  });

  it("an interval edit while enabled starts a new period", () => {
    assert.deepStrictEqual(periodChange(on, { ...on, intervalSeconds: 30 }), {
      close: true,
      open: { intervalSeconds: 30 },
    });
    // While disabled nothing is expected either way.
    assert.deepStrictEqual(periodChange(off, { ...off, intervalSeconds: 30 }), {
      close: false,
      open: null,
    });
  });

  it("other edits and delete", () => {
    assert.deepStrictEqual(periodChange(on, on), { close: false, open: null });
    assert.deepStrictEqual(periodChange(on, null), { close: true, open: null });
  });
});

describe("rollups", () => {
  const allDay: EnabledPeriod[] = [
    { endedAt: null, intervalSeconds: 3600, startedAt: midnight - dayMs },
  ];

  it("count up/down and take latency percentiles of successful samples", () => {
    const samples = [ok(10), ok(30), ok(20), failed, ok(40)];
    const rollup = rollupDay(day, samples, allDay);
    assert.deepStrictEqual(rollup, {
      counted: 5,
      day,
      down: 1,
      expected: 24,
      p50: 20,
      p95: 40,
      up: 4,
    });
    // 5 of 24 expected samples: partial.
    assert.isTrue(isPartial(rollup));
  });

  it("a day without successful samples has no latency", () => {
    const rollup = rollupDay(day, [failed, failed], allDay);
    assert.isNull(rollup.p50);
    assert.isNull(rollup.p95);
    assert.strictEqual(rollup.down, 2);
  });

  it("today accrues expected samples only up to now", () => {
    const now = midnight + 6 * hour;
    const samples = Array.from({ length: 6 }, () => ok(5));
    const rollup = rollupDay(day, samples, allDay, now);
    assert.strictEqual(rollup.expected, 6);
    assert.isFalse(isPartial(rollup));
  });

  it("partial below 80% of expected", () => {
    assert.isFalse(isPartial({ counted: 80, expected: 100 }));
    assert.isTrue(isPartial({ counted: 79, expected: 100 }));
    // Disabled all day: nothing expected, nothing missing.
    assert.isFalse(isPartial({ counted: 0, expected: 0 }));
  });

  it("uptime percent over counted samples", () => {
    assert.strictEqual(uptimePercent(1439, 1440), 99.931);
    assert.strictEqual(uptimePercent(5, 5), 100);
    assert.isNull(uptimePercent(0, 0));
  });

  it("the report sums days", () => {
    const report = uptimeReport([
      uptimeDay(rollupDay(day, [ok(1), failed], allDay), false),
      uptimeDay(
        rollupDay(addDays(day, 1), [ok(1), ok(2)], allDay, midnight + dayMs),
        true
      ),
    ]);
    assert.strictEqual(report.counted, 4);
    assert.strictEqual(report.up, 3);
    assert.strictEqual(report.uptimePercent, 75);
    assert.strictEqual(report.days[0]?.uptimePercent, 50);
    assert.isFalse(report.days[0]?.live);
    assert.isTrue(report.days[1]?.live);
    assert.strictEqual(uptimeReport([]).uptimePercent, null);
  });

  it("uptime over the last days shown matches their samples", () => {
    const days = [
      { counted: 100, up: 0 },
      { counted: 100, up: 100 },
      { counted: 300, up: 297 },
    ];
    // All three: 397 of 500.
    assert.strictEqual(uptimeOfLastDays(days, 90), 79.4);
    // The last two only: 397 of 400.
    assert.strictEqual(uptimeOfLastDays(days, 2), 99.25);
    assert.isNull(uptimeOfLastDays([{ counted: 0, up: 0 }], 1));
  });

  it("report days end today and start no earlier than creation", () => {
    const now = midnight + 3 * hour;
    const days = reportDays(90, midnight - 2 * dayMs + hour, now);
    assert.deepStrictEqual(days, ["2026-09-18", "2026-09-19", day]);
    assert.lengthOf(reportDays(90, 0, now), 90);
    assert.strictEqual(reportDays(90, 0, now).at(-1), day);
  });
});

describe("watermark and retention", () => {
  const createdAt = midnight - 3 * dayMs + hour;

  it("rolls up every closed day after the watermark, from creation", () => {
    const now = midnight + hour;
    assert.deepStrictEqual(daysToRollUp(null, createdAt, now), [
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
    ]);
    assert.deepStrictEqual(daysToRollUp("2026-09-18", createdAt, now), [
      "2026-09-19",
    ]);
    // Today is never closed.
    assert.deepStrictEqual(daysToRollUp("2026-09-19", createdAt, now), []);
    // A day closes exactly at the next midnight.
    assert.deepStrictEqual(
      daysToRollUp("2026-09-19", createdAt, midnight + dayMs),
      [day]
    );
  });

  it("caps the days per run", () => {
    const now = midnight + 100 * dayMs;
    const days = daysToRollUp(null, createdAt, now, 31);
    assert.lengthOf(days, 31);
    assert.strictEqual(days[0], "2026-09-17");
    assert.deepStrictEqual(
      daysToRollUp(days.at(-1) ?? null, createdAt, now, 1),
      ["2026-10-18"]
    );
  });

  it("prunes raw checks only for rolled-up days older than 30 days", () => {
    const now = midnight + 10 * hour;
    // Nothing rolled up: nothing pruned.
    assert.isNull(checksPruneBefore(null, now));
    // Rolled up through yesterday: keep the last 30 days.
    assert.strictEqual(
      checksPruneBefore("2026-09-19", now),
      midnight - 30 * dayMs
    );
    // Watermark lagging behind: nothing after it is pruned.
    assert.strictEqual(
      checksPruneBefore("2026-08-01", now),
      Date.parse("2026-08-02T00:00:00Z")
    );
  });

  it("prunes resolved incidents after 90 days", () => {
    assert.strictEqual(incidentsPruneBefore(midnight), midnight - 90 * dayMs);
  });
});

describe(recentActivity, () => {
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
