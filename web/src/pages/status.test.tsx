import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PublicStatus } from "../../../src/domain/public-status.ts";
import { publicStatusQuery } from "../api/queries.ts";
import { ThemeProvider } from "../theme/theme-provider.tsx";
import { StatusPage } from "./status.tsx";

const now = Date.now();

const status: PublicStatus = {
  generatedAt: now - 5000,
  monitors: [
    {
      days: [
        { day: "2026-09-27", partial: false, uptimePercent: 100 },
        { day: "2026-09-28", partial: true, uptimePercent: 99 },
      ],
      downSince: null,
      lastCheckedAt: now - 1000,
      name: "Website",
      status: "up",
      uptimePercent: 99.95,
    },
    {
      days: [{ day: "2026-09-28", partial: false, uptimePercent: 80 }],
      downSince: now - 3 * 60_000,
      lastCheckedAt: now - 1000,
      name: "API",
      status: "down",
      uptimePercent: 80,
    },
    {
      days: [],
      downSince: null,
      lastCheckedAt: null,
      name: "Batch jobs",
      status: "paused",
      uptimePercent: null,
    },
  ],
  overall: "partial_outage",
};

const renderPage = (data: PublicStatus) => {
  const client = new QueryClient();
  client.setQueryData(publicStatusQuery.queryKey, data);
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <StatusPage />
      </ThemeProvider>
    </QueryClientProvider>
  );
};

describe(StatusPage, () => {
  it("shows the overall status and the open incidents", () => {
    renderPage(status);
    expect(
      screen.getByRole("heading", { name: "Partial outage" })
    ).toBeDefined();
    expect(screen.getByText("1 of 2 monitors down · 1 paused")).toBeDefined();

    const incidents = screen.getByRole("region", { name: "Open incidents" });
    expect(within(incidents).getByText("API is down")).toBeDefined();
    expect(within(incidents).queryByText(/Website/u)).toBeNull();
  });

  it("lists every monitor with its 90 days and uptime", () => {
    renderPage(status);
    const list = screen.getByRole("region", { name: "Monitors" });
    const names = within(list)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(names).toStrictEqual(["Website", "API", "Batch jobs"]);
    expect(within(list).getByText("99.95% uptime")).toBeDefined();
    expect(within(list).getByText("— uptime")).toBeDefined();
    // 90 bars per monitor, padded for young ones.
    expect(document.querySelectorAll("[data-uptime-bars]")).toHaveLength(3);
    for (const bars of document.querySelectorAll("[data-uptime-bars]")) {
      expect(bars.children).toHaveLength(90);
    }
  });

  it("never shows a URL", () => {
    renderPage(status);
    expect(document.body.textContent).not.toMatch(/https?:\/\//u);
  });

  it("drops the incidents panel when nothing is down", () => {
    renderPage({
      ...status,
      monitors: status.monitors.filter((monitor) => monitor.status !== "down"),
      overall: "operational",
    });
    expect(
      screen.getByRole("heading", { name: "All systems operational" })
    ).toBeDefined();
    expect(screen.queryByRole("region", { name: "Open incidents" })).toBeNull();
  });

  it("explains an empty page", () => {
    renderPage({ ...status, monitors: [], overall: "operational" });
    expect(screen.getByText("Nothing to report yet")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Monitors" })).toBeNull();
  });
});
