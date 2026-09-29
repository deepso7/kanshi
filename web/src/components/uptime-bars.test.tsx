import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { UptimeBarDay } from "./uptime-bars.tsx";
import { padDays, UptimeBars, uptimeLevel } from "./uptime-bars.tsx";

const day = (
  index: number,
  uptimePercent: number | null,
  partial = false
): UptimeBarDay => ({
  day: `2026-07-${String(index + 1).padStart(2, "0")}`,
  partial,
  uptimePercent,
});

const bars = () => [
  ...document.querySelectorAll<HTMLElement>(
    "[data-uptime-bars] > [data-level]"
  ),
];
const levels = () => bars().map((bar) => bar.dataset.level);

describe(uptimeLevel, () => {
  it("has no level without samples", () => {
    expect(uptimeLevel(null)).toBe("none");
    expect(uptimeLevel(day(0, null))).toBe("none");
  });

  it("marks days with too few samples as partial", () => {
    expect(uptimeLevel(day(0, null, true))).toBe("partial");
    expect(uptimeLevel(day(0, 100, true))).toBe("partial");
  });

  it("grades a full day by uptime", () => {
    expect(uptimeLevel(day(0, 99.5))).toBe("up");
    expect(uptimeLevel(day(0, 99.4))).toBe("degraded");
    expect(uptimeLevel(day(0, 95))).toBe("degraded");
    expect(uptimeLevel(day(0, 94.9))).toBe("down");
  });
});

describe(padDays, () => {
  it("pads missing leading days and keeps the most recent", () => {
    const days = Array.from({ length: 5 }, (_, index) => day(index, 100));
    expect(padDays(days, 7)).toStrictEqual([null, null, ...days]);
    expect(padDays(days, 3)).toStrictEqual(days.slice(2));
  });
});

describe(UptimeBars, () => {
  it("renders 90 bars, padding a young monitor's missing days", () => {
    const days = [
      day(0, 100, true),
      day(1, 100),
      day(2, 97),
      day(3, 50),
      day(4, null, true),
      day(5, 100),
    ];
    render(<UptimeBars days={days} label="Uptime: 90 days" />);
    expect(levels()).toStrictEqual([
      ...Array.from({ length: 84 }, () => "none"),
      "partial",
      "up",
      "degraded",
      "down",
      "partial",
      "up",
    ]);
  });

  it("announces the label, not the bars", () => {
    render(<UptimeBars days={[day(0, 100)]} label="Uptime: 90 days" />);
    expect(screen.getByText("Uptime: 90 days")).toBeDefined();
    expect(
      document.querySelector("[data-uptime-bars]")?.getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("shows the last `count` days of a longer history", () => {
    const days = Array.from({ length: 120 }, (_, index) =>
      day(index % 28, index < 30 ? 50 : 100)
    );
    render(<UptimeBars count={90} days={days} label="Uptime" />);
    expect(levels()).toStrictEqual(Array.from({ length: 90 }, () => "up"));
  });

  it("gives each level its own look", () => {
    render(
      <UptimeBars
        count={4}
        days={[day(0, 100), day(1, 97), day(2, 10), day(3, null, true)]}
        label="Uptime"
      />
    );
    expect(new Set(bars().map((bar) => bar.className)).size).toBe(4);
  });

  it("shows a bar's date and uptime on hover", async () => {
    const user = userEvent.setup();
    render(
      <UptimeBars
        count={3}
        days={[day(0, 100), day(1, 97.25), day(2, 100, true)]}
        label="Uptime"
      />
    );
    const [, degraded] = bars();
    if (degraded === undefined) {
      throw new Error("no second bar");
    }
    await user.hover(degraded);
    await expect(
      screen.findByText("2026-07-02: 97.25%")
    ).resolves.toBeDefined();
  });
});
