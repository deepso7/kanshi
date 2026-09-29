import { describe, expect, it } from "vitest";

import type { RecentSample } from "./recent-activity.ts";
import {
  combinedUptime,
  latencyRange,
  latencyValues,
  latestLatency,
  uptimeTone,
} from "./recent-activity.ts";

const sample = (
  up: number,
  counted: number,
  latencies: readonly (number | null)[] = []
): RecentSample => ({
  buckets: latencies.map((latencyMs) => ({ latencyMs })),
  counted,
  up,
});

describe(combinedUptime, () => {
  it("weights each monitor by its samples", () => {
    // 90 + 10 up of 100 + 100: 50%, not the 45% mean of 90% and 0%.
    expect(combinedUptime([sample(90, 100), sample(10, 100)])).toBe(50);
    expect(combinedUptime([sample(99, 100), sample(0, 0)])).toBe(99);
  });

  it("skips unreadable monitors and has no value without samples", () => {
    expect(combinedUptime([null, sample(3, 4)])).toBe(75);
    expect(combinedUptime([])).toBeNull();
    expect(combinedUptime([null, sample(0, 0)])).toBeNull();
  });
});

describe("latency", () => {
  const recent = sample(1, 1, [null, 120, 80, null, 95, null]);

  it("reads the buckets oldest first, gaps kept", () => {
    expect(latencyValues(recent)).toStrictEqual([
      null,
      120,
      80,
      null,
      95,
      null,
    ]);
    expect(latencyValues(null)).toStrictEqual([]);
  });

  it("finds the latest sample and the range", () => {
    expect(latestLatency(recent)).toBe(95);
    expect(latencyRange(recent)).toStrictEqual({ max: 120, min: 80 });
  });

  it("has neither without samples", () => {
    expect(latestLatency(sample(0, 0, [null, null]))).toBeNull();
    expect(latencyRange(sample(0, 0, [null]))).toBeNull();
    expect(latencyRange(null)).toBeNull();
  });
});

describe(uptimeTone, () => {
  it.each([
    [null, "muted"],
    [100, "success"],
    [99.5, "success"],
    [99.49, "warning"],
    [95, "warning"],
    [94.99, "danger"],
    [0, "danger"],
  ] as const)("grades %s as %s", (percent, tone) => {
    expect(uptimeTone(percent)).toBe(tone);
  });
});
