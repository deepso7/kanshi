import type {
  OverallStatus,
  PublicMonitor,
  PublicStatus,
} from "../domain/public-status.ts";
import { uptimeBars } from "./charts.ts";
import { formatDuration, formatPercent, timeTag } from "./format.ts";
import type { Html } from "./html.ts";
import { html } from "./html.ts";
import { page } from "./layout.ts";

const overallText: Record<OverallStatus, string> = {
  major_outage: "Major outage",
  operational: "All systems operational",
  partial_outage: "Partial outage",
};

const monitorStatusText: Record<PublicMonitor["status"], string> = {
  down: "Down",
  paused: "Paused",
  unknown: "Pending",
  up: "Operational",
};

const statusMonitor = (monitor: PublicMonitor): Html => html`<div
  class="status-monitor"
>
  <div class="row spread">
    <strong>${monitor.name}</strong>
    <span class="row small">
      <span class="muted">${formatPercent(monitor.uptimePercent)} uptime</span>
      <span
        class="badge ${
          monitor.status === "up" || monitor.status === "down"
            ? monitor.status
            : ""
        }"
        ><span class="dot ${monitor.status}"></span>${
          monitorStatusText[monitor.status]
        }</span
      >
    </span>
  </div>
  <div style="margin-top:.5rem">${uptimeBars(monitor.days)}</div>
  <div class="axis"><span>90 days ago</span><span>today</span></div>
</div>`;

const openIncidents = (status: PublicStatus): Html | null => {
  const down = status.monitors.filter((monitor) => monitor.status === "down");
  return down.length === 0
    ? null
    : html`<h2>Open incidents</h2>
        <div class="panel stack">
          ${down.map(
            (monitor) =>
              html`<div>
                <strong>${monitor.name}</strong> is
                down${
                  monitor.downSince !== null &&
                  html` since ${timeTag(monitor.downSince)}
                    <span class="muted"
                      >(${formatDuration(status.generatedAt - monitor.downSince)})</span
                    >`
                }.
              </div>`
          )}
        </div>`;
};

/**
 * The public status page: overall banner, open incidents and 90-day bars
 * of the monitors that are public. Never shows URLs or failure details.
 */
export const statusPage = (status: PublicStatus): Html =>
  page({
    body: html`<div class="stack">
      <h1>Status</h1>
      <div class="banner ${status.overall}" role="status">
        ${overallText[status.overall]}
      </div>
      ${openIncidents(status)}
      <h2>Services</h2>
      <div class="panel">
        ${
          status.monitors.length === 0
            ? html`<p class="empty">Nothing to show yet.</p>`
            : status.monitors.map(statusMonitor)
        }
        <div class="legend" style="margin-top:1rem">
          <span><i style="background:var(--ok)"></i>≥ 99.5%</span>
          <span><i style="background:var(--warn)"></i>≥ 95%</span>
          <span><i style="background:var(--bad)"></i>&lt; 95%</span>
          <span><i style="background:var(--partial)"></i>partial data</span>
          <span><i style="background:var(--none)"></i>no data</span>
        </div>
      </div>
      <footer>
        Updated ${timeTag(status.generatedAt)} · Days are UTC · Powered by
        Kanshi
      </footer>
    </div>`,
    refreshSeconds: 60,
    title: "Status",
  });
