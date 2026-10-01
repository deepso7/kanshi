import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PublicDay,
  PublicMonitor,
  PublicStatus,
} from "../../../src/domain/public-status.ts";
import { publicStatusQuery } from "../api/queries.ts";
import { ThemeProvider } from "../theme/theme-provider.tsx";
import { StatusPage } from "./status.tsx";

const now = Date.now();

/** A full day of 1440 samples at `uptimePercent`. */
const fullDay = (day: string, uptimePercent: number): PublicDay => ({
  counted: 1440,
  day,
  partial: false,
  up: Math.round((1440 * uptimePercent) / 100),
  uptimePercent,
});

/** `count` consecutive days from 2026-06-01, each at `percentOf(index)`. */
const history = (count: number, percentOf: (index: number) => number) =>
  Array.from({ length: count }, (_, index) =>
    fullDay(
      new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
      percentOf(index)
    )
  );

/** Narrow the viewport as far as the page's media queries go. */
const narrowScreen = () => {
  const original = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    original(query === "(min-width: 640px)" ? "(min-width: 100000px)" : query)
  );
};

const website: PublicMonitor = {
  days: [
    {
      counted: 2000,
      day: "2026-09-27",
      partial: false,
      up: 2000,
      uptimePercent: 100,
    },
    {
      counted: 2000,
      day: "2026-09-28",
      partial: true,
      up: 1998,
      uptimePercent: 99.9,
    },
  ],
  downSince: null,
  name: "Website",
  ref: "a1b2c3d4e5f60718",
  status: "up",
  uptimePercent: 99.95,
};

const api: PublicMonitor = {
  days: [fullDay("2026-09-28", 80)],
  downSince: now - 3 * 60_000,
  name: "API",
  ref: "0f1e2d3c4b5a6978",
  status: "down",
  uptimePercent: 80,
};

const status: PublicStatus = {
  generatedAt: now - 5000,
  monitors: [
    website,
    api,
    {
      days: [],
      downSince: null,
      name: "Batch jobs",
      ref: "8899aabbccddeeff",
      status: "paused",
      uptimePercent: null,
    },
  ],
  overall: "partial_outage",
};

/** 30 bad days (50%), then 60 perfect ones; the API's 90 days: 83.33%. */
const skewed: PublicStatus = {
  ...status,
  monitors: [
    {
      ...website,
      days: history(90, (index) => (index < 30 ? 50 : 100)),
      uptimePercent: 83.333,
    },
  ],
};

/** The monitors panel's period, axis, uptime and announced summary. */
const uptimeRowTexts = () => {
  const list = within(screen.getByRole("region", { name: "Monitors" }));
  return [
    list.getByText(/^Uptime \/\/ /u),
    list.getByText(/days ago$/u),
    list.getByText(/% uptime$/u),
    list.getByText(/^Website: /u),
  ].map((element) => element.textContent);
};

const barCount = () =>
  document.querySelector("[data-uptime-bars]")?.children.length;

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("gives the uptime over the 90 days the bars show when wide", () => {
    renderPage(skewed);
    // 50% for 30 days, 100% for 60: 83.33%.
    expect(uptimeRowTexts()).toStrictEqual([
      "Uptime // 90 days",
      "90 days ago",
      "83.33% uptime",
      "Website: 83.33% uptime over 90 days",
    ]);
    expect(barCount()).toBe(90);
  });

  it("gives the uptime over the 60 days the bars show when narrow", () => {
    narrowScreen();
    renderPage(skewed);
    // Only the perfect days are shown: 100%, not the 90-day 83.33%.
    expect(uptimeRowTexts()).toStrictEqual([
      "Uptime // 60 days",
      "60 days ago",
      "100% uptime",
      "Website: 100% uptime over 60 days",
    ]);
    expect(barCount()).toBe(60);
  });

  it("keeps same-named monitors apart", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const twin = { ...api, ref: "ffeeddccbbaa9988" };
    renderPage({ ...status, monitors: [website, api, twin] });
    const incidents = screen.getByRole("region", { name: "Open incidents" });
    expect(within(incidents).getAllByText("API is down")).toHaveLength(2);
    const list = screen.getByRole("region", { name: "Monitors" });
    expect(
      within(list).getAllByRole("heading", { level: 3, name: "API" })
    ).toHaveLength(2);
    // React warns about duplicate keys through console.error.
    expect(errors).not.toHaveBeenCalled();
  });

  it("never shows a URL", () => {
    renderPage(status);
    expect(document.body.textContent).not.toMatch(/https?:\/\//u);
  });

  it("says so when nothing is down", () => {
    renderPage({
      ...status,
      monitors: status.monitors.filter((monitor) => monitor.status !== "down"),
      overall: "operational",
    });
    expect(
      screen.getByRole("heading", { name: "All systems operational" })
    ).toBeDefined();
    const incidents = screen.getByRole("region", { name: "Open incidents" });
    expect(within(incidents).getByText("No open incidents.")).toBeDefined();
  });

  it("explains an empty page", () => {
    renderPage({ ...status, monitors: [], overall: "operational" });
    expect(screen.getByText("Nothing to report yet")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Monitors" })).toBeNull();
  });
});
