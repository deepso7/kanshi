import { describe, expect, it } from "vitest";

import {
  formatAgo,
  formatDateTime,
  formatDay,
  formatDuration,
  formatInterval,
  formatLatency,
  formatPercent,
  formatUtc,
} from "./format.ts";

const utc = { locale: "en-US", timeZone: "UTC" };
const now = 1_000_000_000;

describe(formatDuration, () => {
  it.each([
    [45_000, "45s"],
    [252_000, "4m 12s"],
    [3_600_000, "1h"],
    [3_725_000, "1h 2m"],
    [90_000_000, "1d 1h"],
    [-5, "0s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("formats an interval in seconds", () => {
    expect(formatInterval(300)).toBe("5m");
  });
});

describe(formatAgo, () => {
  it.each([
    [null, "never"],
    [now - 1000, "just now"],
    [now + 60_000, "just now"],
    [now - 12_000, "12s ago"],
    [now - 5 * 60_000, "5m ago"],
    [now - 3 * 3_600_000, "3h ago"],
    [now - 49 * 3_600_000, "2d ago"],
  ])("formats %s as %s", (at, text) => {
    expect(formatAgo(at, now)).toBe(text);
  });
});

describe(formatPercent, () => {
  it("truncates, so only a perfect record reads 100%", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(99.999)).toBe("99.99%");
    expect(formatPercent(0)).toBe("0.00%");
  });
});

describe(formatLatency, () => {
  it("uses ms below a second, seconds above", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(142.4)).toBe("142 ms");
    expect(formatLatency(1240)).toBe("1.24 s");
  });
});

describe("dates", () => {
  const at = Date.UTC(2026, 8, 28, 18, 40);

  it("formats UTC and local date-times", () => {
    expect(formatUtc(at)).toBe("2026-09-28 18:40 UTC");
    expect(formatDateTime(at, utc, at)).toBe("Sep 28, 18:40");
    expect(formatDateTime(at, utc, Date.UTC(2027, 0, 2))).toBe(
      "Sep 28, 2026, 18:40"
    );
  });

  it("formats an API day without shifting it", () => {
    expect(formatDay("2026-09-28", { locale: "en-US" })).toBe("Sep 28, 2026");
  });
});
