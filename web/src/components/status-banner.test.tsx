import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PublicMonitorStatus } from "../../../src/domain/public-status.ts";
import { StatusBanner, statusBannerView } from "./status-banner.tsx";

const monitors = (...statuses: PublicMonitorStatus[]) =>
  statuses.map((status) => ({ status }));

describe(statusBannerView, () => {
  it("titles and tones each overall status", () => {
    expect(statusBannerView("operational", monitors("up"))).toMatchObject({
      title: "All systems operational",
      tone: "success",
    });
    expect(
      statusBannerView("partial_outage", monitors("up", "down"))
    ).toMatchObject({ title: "Partial outage", tone: "warning" });
    expect(statusBannerView("major_outage", monitors("down"))).toMatchObject({
      title: "Major outage",
      tone: "danger",
    });
  });

  it("counts the watched monitors, leaving paused ones aside", () => {
    expect(
      statusBannerView("operational", monitors("up", "unknown")).summary
    ).toBe("2 monitors, none down");
    expect(
      statusBannerView("partial_outage", monitors("up", "down", "up")).summary
    ).toBe("1 of 3 monitors down");
    expect(
      statusBannerView("major_outage", monitors("down", "paused", "paused"))
        .summary
    ).toBe("1 of 1 monitor down · 2 paused");
    expect(statusBannerView("operational", monitors("up")).summary).toBe(
      "1 monitor, none down"
    );
  });

  it("explains an empty or fully paused page", () => {
    expect(statusBannerView("operational", []).summary).toBe(
      "No monitors are published yet"
    );
    expect(
      statusBannerView("operational", monitors("paused", "paused")).summary
    ).toBe("2 monitors, all paused");
  });
});

describe(StatusBanner, () => {
  it("shows the title, the summary and the meta line", () => {
    render(
      <StatusBanner
        meta="Updated just now"
        monitors={monitors("up", "down")}
        overall="partial_outage"
      />
    );
    const banner = screen.getByRole("region", { name: "Overall status" });
    expect(banner.dataset.overall).toBe("partial_outage");
    expect(
      screen.getByRole("heading", { name: "Partial outage" })
    ).toBeDefined();
    expect(screen.getByText("1 of 2 monitors down")).toBeDefined();
    expect(screen.getByText("Updated just now")).toBeDefined();
  });

  it("gives each overall status its own pill", () => {
    const pills = (
      ["operational", "partial_outage", "major_outage"] as const
    ).map((overall) => {
      const { unmount } = render(
        <StatusBanner monitors={[]} overall={overall} />
      );
      const pill = screen.getByRole("region").querySelector("[data-tone]");
      const look = [pill?.className, pill?.textContent];
      unmount();
      return look;
    });
    expect(new Set(pills.map(([className]) => className)).size).toBe(3);
    expect(pills.map(([, text]) => text)).toStrictEqual([
      "Operational",
      "Degraded",
      "Outage",
    ]);
  });
});
