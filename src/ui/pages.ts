import type {
  ChannelTestResult,
  DevEventView,
  MonitorResponse,
} from "../api/spec.ts";
import type { ChannelKind, ChannelView } from "../domain/channel.ts";
import type {
  IncidentWithAlerts,
  RecentActivity,
  UptimeReport,
} from "../domain/history.ts";
import { minIntervalSeconds } from "../domain/monitor-input.ts";
import type { DisplayStatus } from "../domain/monitor.ts";
import { displayStatus } from "../domain/monitor.ts";
import type { CheckRow } from "../monitor/storage.ts";
import type { MonitorWithRecent } from "../service/monitors.ts";
import { statusCounts } from "../service/monitors.ts";
import { sparkline, uptimeBars } from "./charts.ts";
import { agoTag, formatDuration, formatPercent, timeTag } from "./format.ts";
import type { FormFields } from "./forms.ts";
import type { Html } from "./html.ts";
import { html, safeHref } from "./html.ts";
import type { Flash } from "./layout.ts";
import { flashBox, page } from "./layout.ts";

const statusLabel: Record<DisplayStatus, string> = {
  down: "Down",
  paused: "Paused",
  unknown: "Pending",
  up: "Up",
};

const statusBadge = (status: DisplayStatus): Html =>
  html`<span class="badge ${status === "up" || status === "down" ? status : ""}"
    ><span class="dot ${status}"></span>${statusLabel[status]}</span
  >`;

const postButton = (
  action: string,
  label: string,
  options: {
    readonly className?: string;
    readonly confirm?: string;
    readonly fields?: Readonly<Record<string, string>>;
  } = {}
): Html => html`<form
  class="inline"
  method="post"
  action="${action}"
  ${options.confirm !== undefined && html`data-confirm="${options.confirm}"`}
>
  ${Object.entries(options.fields ?? {}).map(
    ([name, value]) =>
      html`<input type="hidden" name="${name}" value="${value}" />`
  )}
  <button type="submit" class="${options.className ?? ""}">${label}</button>
</form>`;

const monitorPath = (id: string) => `/monitors/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// Login

export const loginPage = (error: string | null): Html =>
  page({
    body: html`<div class="login panel stack">
      <div>
        <h1>Kanshi</h1>
        <p class="muted">Sign in with the API token (KANSHI_API_TOKEN).</p>
      </div>
      ${flashBox(error === null ? null : { kind: "error", text: error })}
      <form method="post" action="/login" class="stack">
        <div>
          <label for="token">API token</label>
          <input
            id="token"
            name="token"
            type="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </div>
        <button type="submit" class="primary">Sign in</button>
      </form>
      <p class="small muted">
        Public status page: <a href="/status">/status</a>
      </p>
    </div>`,
    title: "Sign in",
  });

// ---------------------------------------------------------------------------
// Dashboard

export type DashboardRow = MonitorWithRecent;

export interface DashboardData {
  /** Dev stage only: the webhook sink's latest events, newest first. */
  readonly devEvents: readonly DevEventView[] | null;
  readonly flash: Flash | null;
  readonly now: number;
  readonly rows: readonly DashboardRow[];
}

const devEventsPanel = (events: readonly DevEventView[], now: number): Html =>
  html`<h2>
      Dev webhook sink <span class="muted small">(dev stage only)</span>
    </h2>
    <div class="panel table-wrap">
      ${
        events.length === 0
          ? html`<p class="empty">No alerts received yet.</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Reply</th>
                  <th>Query</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                ${events.map(
                  (event) => html`<tr>
                    <td class="small">${agoTag(event.at, now)}</td>
                    <td class="small">${String(event.respondedWith ?? "")}</td>
                    <td class="mono">${event.query ?? ""}</td>
                    <td class="small">${event.message}</td>
                  </tr>`
                )}
              </tbody>
            </table>`
      }
    </div>`;

const notCheckedBanner = (rows: readonly DashboardRow[]): Html | null => {
  const stale = rows.filter((row) => row.entry.watch.episodeId !== null);
  return stale.length === 0
    ? null
    : html`<div class="flash warn" role="alert">
        <strong>Not being checked:</strong>
        ${stale.map(
          (row, index) =>
            html`${index > 0 && ", "}<a href="${monitorPath(row.entry.id)}"
                >${row.entry.summary.name}</a
              >`
        )}.
        The watchdog has alerted every channel; checks are overdue.
      </div>`;
};

const dashboardRow = (row: DashboardRow, now: number): Html => {
  const { entry, recent } = row;
  const status = displayStatus(entry.summary);
  return html`<tr>
    <td>${statusBadge(status)}</td>
    <td>
      <a href="${monitorPath(entry.id)}"
        ><strong>${entry.summary.name}</strong></a
      >
      ${entry.public && html` <span class="badge">public</span>`}
      ${entry.managed && html` <span class="badge">config</span>`}
      ${
        entry.watch.episodeId !== null &&
        html` <span class="badge warn">not checked</span>`
      }
    </td>
    <td class="small">${agoTag(entry.summary.lastCheckedAt, now)}</td>
    <td class="num">${formatPercent(recent?.uptimePercent ?? null)}</td>
    <td>
      ${recent === null ? html`<span class="muted">—</span>` : sparkline(recent.buckets)}
    </td>
    <td class="num small muted">
      every ${formatDuration(entry.summary.intervalSeconds * 1000)}
    </td>
  </tr>`;
};

export const dashboardPage = (data: DashboardData): Html => {
  const counts = statusCounts(data.rows.map((row) => row.entry));
  return page({
    body: html`${flashBox(data.flash)} ${notCheckedBanner(data.rows)}
      <div class="row spread">
        <div>
          <h1>Monitors</h1>
          <div class="stats small muted">
            <span class="stat"><b>${counts.up}</b>up</span>
            <span class="stat"><b>${counts.down}</b>down</span>
            <span class="stat"><b>${counts.unknown}</b>pending</span>
            <span class="stat"><b>${counts.paused}</b>paused</span>
          </div>
        </div>
        <a class="button primary" href="/monitors/new">New monitor</a>
      </div>
      <h2>All monitors</h2>
      <div class="panel table-wrap">
        ${
          data.rows.length === 0
            ? html`<p class="empty">
                No monitors yet. <a href="/monitors/new">Add the first one</a>.
              </p>`
            : html`<table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Name</th>
                    <th>Last check</th>
                    <th class="num">24h uptime</th>
                    <th>Latency (24h)</th>
                    <th class="num">Interval</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.rows.map((row) => dashboardRow(row, data.now))}
                </tbody>
              </table>`
        }
      </div>
      ${data.devEvents !== null && devEventsPanel(data.devEvents, data.now)}`,
    refreshSeconds: 30,
    section: "dashboard",
    title: "Monitors",
  });
};

// ---------------------------------------------------------------------------
// Monitor detail

export interface MonitorDetailData {
  readonly channels: readonly ChannelView[];
  readonly checks: readonly CheckRow[];
  readonly flash: Flash | null;
  readonly incidents: readonly IncidentWithAlerts[];
  readonly monitor: MonitorResponse;
  readonly now: number;
  readonly recent: RecentActivity | null;
  readonly uptime: UptimeReport | null;
  /** The watchdog's open "not being checked" episode, if any. */
  readonly notChecked: boolean;
}

const checkResult = (check: CheckRow): Html => {
  if (check.ok) {
    return html`<span class="badge up">ok</span>`;
  }
  return html`<span class="badge down">${check.errorKind ?? "failed"}</span>`;
};

const checksTable = (checks: readonly CheckRow[], now: number): Html =>
  checks.length === 0
    ? html`<p class="empty">No checks yet.</p>`
    : html`<table>
        <thead>
          <tr>
            <th>When</th>
            <th>Kind</th>
            <th>Result</th>
            <th class="num">HTTP</th>
            <th class="num">Latency</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          ${checks.map(
            (check) => html`<tr>
              <td class="small">${agoTag(check.at, now)}</td>
              <td class="small">
                ${check.kind}${!check.counted && html` <span class="muted">(not counted)</span>`}
              </td>
              <td>${checkResult(check)}</td>
              <td class="num">${check.status ?? "—"}</td>
              <td class="num">
                ${check.latencyMs === null ? "—" : `${check.latencyMs} ms`}
              </td>
              <td class="small muted">${check.message ?? ""}</td>
            </tr>`
          )}
        </tbody>
      </table>`;

const alertSummary = (
  incident: IncidentWithAlerts,
  channelNames: ReadonlyMap<string, string>
): Html => {
  if (incident.alerts.length === 0) {
    return html`<span class="muted">none</span>`;
  }
  return html`${incident.alerts.map(
    (alert) =>
      html`<div class="small">
        ${alert.event} →
        ${channelNames.get(alert.channelId) ?? "(deleted channel)"}:
        <span class="${alert.state === "failed" ? "badge down" : "badge"}"
          >${alert.state}</span
        >${
          alert.lastError !== null &&
          html` <span class="muted">${alert.lastError}</span>`
        }
      </div>`
  )}`;
};

const incidentsTable = (
  incidents: readonly IncidentWithAlerts[],
  channels: readonly ChannelView[],
  now: number
): Html => {
  if (incidents.length === 0) {
    return html`<p class="empty">No incidents.</p>`;
  }
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  return html`<table>
    <thead>
      <tr>
        <th>Started</th>
        <th>Duration</th>
        <th>Cause</th>
        <th>Alerts</th>
      </tr>
    </thead>
    <tbody>
      ${incidents.map(
        (incident) => html`<tr>
          <td class="small">${timeTag(incident.startedAt)}</td>
          <td class="small">
            ${
              incident.resolvedAt === null
                ? html`<span class="badge down">ongoing</span>
                    ${formatDuration(now - incident.startedAt)}`
                : html`${formatDuration(incident.resolvedAt - incident.startedAt)}
                    <span class="muted"
                      >(${incident.resolution ?? "resolved"})</span
                    >`
            }
          </td>
          <td class="small">
            ${incident.cause}${
              incident.lastHttpStatus !== null &&
              html` <span class="muted"
                >(HTTP ${incident.lastHttpStatus})</span
              >`
            }
          </td>
          <td>${alertSummary(incident, names)}</td>
        </tr>`
      )}
    </tbody>
  </table>`;
};

const channelsText = (
  selection: MonitorResponse["channels"],
  channels: readonly ChannelView[]
): string => {
  if (selection === "all") {
    return "all channels";
  }
  if (selection.length === 0) {
    return "no alerts";
  }
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  return selection.map((id) => names.get(id) ?? "(deleted)").join(", ");
};

export const monitorPage = (data: MonitorDetailData): Html => {
  const { monitor, now } = data;
  const path = monitorPath(monitor.id);
  const status = displayStatus({
    enabled: monitor.enabled,
    status: monitor.state.status,
  });
  const days = data.uptime?.days ?? [];
  return page({
    body: html`${flashBox(data.flash)}
      ${
        data.notChecked &&
        html`<div class="flash warn" role="alert">
          The watchdog reports this monitor is not being checked.
        </div>`
      }
      <div class="row spread">
        <div>
          <h1>${monitor.name}</h1>
          <div class="row small">
            ${statusBadge(status)}
            ${
              monitor.public
                ? html`<span class="badge">public</span>`
                : html`<span class="badge">private</span>`
            }
            ${monitor.managed && html`<span class="badge">managed by config</span>`}
            <a
              class="mono"
              href="${safeHref(monitor.url)}"
              rel="noopener noreferrer"
              >${monitor.url}</a
            >
          </div>
        </div>
        <div class="row">
          ${monitor.enabled && postButton(`${path}/check`, "Check now")}
          ${
            monitor.enabled
              ? postButton(`${path}/pause`, "Pause")
              : postButton(`${path}/resume`, "Resume")
          }
          ${postButton(
            `${path}/public`,
            monitor.public ? "Make private" : "Make public",
            { fields: { public: monitor.public ? "false" : "true" } }
          )}
          <a class="button" href="${path}/edit">Edit</a>
          ${postButton(`${path}/delete`, "Delete", {
            className: "danger",
            confirm: `Delete "${monitor.name}" and all its history?`,
          })}
        </div>
      </div>

      <div class="grid" style="margin-top:1.5rem">
        <div class="panel">
          <div class="muted small">Last check</div>
          <div>${agoTag(monitor.state.lastCheckedAt, now)}</div>
        </div>
        <div class="panel">
          <div class="muted small">24h uptime</div>
          <div>${formatPercent(data.recent?.uptimePercent ?? null)}</div>
        </div>
        <div class="panel">
          <div class="muted small">90-day uptime</div>
          <div>${formatPercent(data.uptime?.uptimePercent ?? null)}</div>
        </div>
        <div class="panel">
          <div class="muted small">Checks</div>
          <div class="small">
            ${monitor.method} every
            ${formatDuration(monitor.intervalSeconds * 1000)}, expects
            ${monitor.expectedStatus}${
              monitor.bodyContains !== null &&
              html`, body contains “${monitor.bodyContains}”`
            }
          </div>
        </div>
      </div>

      <h2>Uptime, last 90 days</h2>
      <div class="panel">
        ${uptimeBars(days)}
        <div class="axis"><span>90 days ago</span><span>today</span></div>
        <div class="legend" style="margin-top:.5rem">
          <span
            ><i class="bar-ok" style="background:var(--ok)"></i>≥ 99.5%</span
          >
          <span><i style="background:var(--warn)"></i>≥ 95%</span>
          <span><i style="background:var(--bad)"></i>&lt; 95%</span>
          <span><i style="background:var(--partial)"></i>partial data</span>
          <span><i style="background:var(--none)"></i>no data</span>
        </div>
      </div>

      <h2>Latency, last 24 hours</h2>
      <div class="panel">
        ${
          data.recent === null
            ? html`<p class="muted">Unavailable.</p>`
            : sparkline(data.recent.buckets, {
                fluid: true,
                height: 60,
                width: 960,
              })
        }
      </div>

      <h2>Incidents</h2>
      <div class="panel table-wrap">
        ${incidentsTable(data.incidents, data.channels, now)}
      </div>

      <h2>Recent checks</h2>
      <div class="panel table-wrap">${checksTable(data.checks, now)}</div>

      <h2>Settings</h2>
      <div class="panel small">
        <div>
          Key:
          <span class="mono">${monitor.key}</span>
          ${monitor.managed && html`<span class="badge">managed by config</span>`}
        </div>
        <div>
          Timeout ${monitor.timeoutMs / 1000}s · down after
          ${monitor.failureThreshold} failure(s) · up after
          ${monitor.successThreshold} success(es)
        </div>
        <div>Alerts: ${channelsText(monitor.channels, data.channels)}</div>
      </div>`,
    section: "dashboard",
    title: monitor.name,
  });
};

// ---------------------------------------------------------------------------
// Monitor form

export interface MonitorFormValues {
  readonly bodyContains: string;
  readonly channelMode: "all" | "some";
  readonly channels: readonly string[];
  readonly enabled: boolean;
  readonly expectedStatus: string;
  readonly failureThreshold: string;
  readonly intervalSeconds: string;
  readonly key: string;
  readonly method: string;
  readonly name: string;
  readonly public: boolean;
  readonly successThreshold: string;
  readonly timeoutSeconds: string;
  readonly url: string;
}

export const defaultMonitorValues: MonitorFormValues = {
  bodyContains: "",
  channelMode: "all",
  channels: [],
  enabled: true,
  expectedStatus: "2xx",
  failureThreshold: "1",
  intervalSeconds: "60",
  key: "",
  method: "GET",
  name: "",
  public: false,
  successThreshold: "1",
  timeoutSeconds: "10",
  url: "",
};

export const monitorValues = (monitor: MonitorResponse): MonitorFormValues => ({
  bodyContains: monitor.bodyContains ?? "",
  channelMode: monitor.channels === "all" ? "all" : "some",
  channels: monitor.channels === "all" ? [] : monitor.channels,
  enabled: monitor.enabled,
  expectedStatus: monitor.expectedStatus,
  failureThreshold: String(monitor.failureThreshold),
  intervalSeconds: String(monitor.intervalSeconds),
  key: monitor.key,
  method: monitor.method,
  name: monitor.name,
  public: monitor.public,
  successThreshold: String(monitor.successThreshold),
  timeoutSeconds: String(monitor.timeoutMs / 1000),
  url: monitor.url,
});

/** A submitted form, re-rendered after an error. */
export const submittedMonitorValues = (form: FormFields): MonitorFormValues => {
  const get = (name: string) => form.find(([key]) => key === name)?.[1] ?? "";
  return {
    bodyContains: get("bodyContains"),
    channelMode: get("channelMode") === "some" ? "some" : "all",
    channels: form.filter(([key]) => key === "channel").map(([, id]) => id),
    enabled: form.some(([key]) => key === "enabled"),
    expectedStatus: get("expectedStatus"),
    failureThreshold: get("failureThreshold"),
    intervalSeconds: get("intervalSeconds"),
    key: get("key"),
    method: get("method"),
    name: get("name"),
    public: form.some(([key]) => key === "public"),
    successThreshold: get("successThreshold"),
    timeoutSeconds: get("timeoutSeconds"),
    url: get("url"),
  };
};

export interface MonitorFormData {
  readonly channels: readonly ChannelView[];
  readonly devMode: boolean;
  readonly error: string | null;
  /** Null for a new monitor. */
  readonly monitor: Pick<MonitorResponse, "id" | "managed" | "name"> | null;
  readonly values: MonitorFormValues;
}

const textField = (
  name: string,
  label: string,
  value: string,
  options: {
    readonly hint?: string;
    /** The element id, when `name` is not unique on the page. */
    readonly id?: string;
    readonly placeholder?: string;
    readonly required?: boolean;
    readonly type?: "number" | "text" | "url";
    readonly min?: number;
    readonly max?: number;
    readonly step?: string;
  } = {}
): Html => html`<div class="field">
  <label for="${options.id ?? name}">${label}</label>
  <input
    id="${options.id ?? name}"
    name="${name}"
    type="${options.type ?? "text"}"
    value="${value}"
    ${
      options.placeholder !== undefined &&
      html`placeholder="${options.placeholder}"`
    }
    ${options.min !== undefined && html`min="${options.min}"`}
    ${options.max !== undefined && html`max="${options.max}"`}
    ${options.step !== undefined && html`step="${options.step}"`}
    ${options.required === true && html`required`}
  />
  ${options.hint !== undefined && html`<div class="hint">${options.hint}</div>`}
</div>`;

const checkbox = (name: string, label: string, isChecked: boolean): Html =>
  html`<label class="check"
    ><input type="checkbox" name="${name}" ${isChecked && html`checked`} />
    ${label}</label
  >`;

const channelPicker = (
  values: MonitorFormValues,
  channels: readonly ChannelView[]
): Html => html`<fieldset>
  <legend>Alerts</legend>
  <label class="check"
    ><input
      type="radio"
      name="channelMode"
      value="all"
      ${values.channelMode === "all" && html`checked`}
    />
    All channels (including ones added later)</label
  >
  <label class="check"
    ><input
      type="radio"
      name="channelMode"
      value="some"
      ${values.channelMode === "some" && html`checked`}
    />
    Only these channels:</label
  >
  <div style="padding-left:1.5rem">
    ${
      channels.length === 0
        ? html`<div class="hint">
            No channels yet. <a href="/channels">Add one</a>.
          </div>`
        : channels.map(
            (channel) =>
              html`<label class="check"
                ><input
                  type="checkbox"
                  name="channel"
                  value="${channel.id}"
                  ${values.channels.includes(channel.id) && html`checked`}
                />
                ${channel.name}
                <span class="muted">(${channel.kind})</span></label
              >`
          )
    }
  </div>
</fieldset>`;

/** Shown where a managed (config sync) resource can be edited. */
const managedWarning = (kind: "channel" | "monitor"): Html =>
  html`<div class="flash warn" role="note">
    This ${kind} is managed by config (<span class="mono">kanshi.config.ts</span
    >). The next <span class="mono">kanshi sync</span> overwrites changes made
    here; edit the config instead.
  </div>`;

export const monitorFormPage = (data: MonitorFormData): Html => {
  const { values } = data;
  const isNew = data.monitor === null;
  const action = isNew ? "/monitors" : monitorPath(data.monitor.id);
  const title = isNew ? "New monitor" : `Edit ${data.monitor.name}`;
  const minInterval = minIntervalSeconds(data.devMode);
  return page({
    body: html`<div class="row spread">
        <h1>${title}</h1>
        <a href="${isNew ? "/" : action}">Cancel</a>
      </div>
      ${flashBox(data.error === null ? null : { kind: "error", text: data.error })}
      ${data.monitor?.managed === true && managedWarning("monitor")}
      <form method="post" action="${action}" class="panel stack">
        <div class="grid">
          ${textField("name", "Name", values.name, { required: true })}
          ${textField("url", "URL", values.url, {
            hint: "http(s) only; https is assumed without a scheme.",
            placeholder: "https://example.com/health",
            required: true,
          })}
        </div>
        <div class="grid">
          <div class="field">
            <label for="method">Method</label>
            <select id="method" name="method">
              ${["GET", "HEAD"].map(
                (method) =>
                  html`<option
                    value="${method}"
                    ${values.method === method && html`selected`}
                  >
                    ${method}
                  </option>`
              )}
            </select>
          </div>
          ${textField(
            "expectedStatus",
            "Expected status",
            values.expectedStatus,
            {
              hint: "200, 2xx, or a list like 200,204",
            }
          )}
          ${textField("bodyContains", "Body contains", values.bodyContains, {
            hint: "Optional keyword the response must contain (GET only).",
          })}
        </div>
        <div class="grid">
          ${textField(
            "intervalSeconds",
            "Interval (seconds)",
            values.intervalSeconds,
            {
              min: minInterval,
              type: "number",
            }
          )}
          ${textField(
            "timeoutSeconds",
            "Timeout (seconds)",
            values.timeoutSeconds,
            {
              max: 30,
              min: 1,
              step: "any",
              type: "number",
            }
          )}
          ${textField(
            "failureThreshold",
            "Down after N failures",
            values.failureThreshold,
            {
              max: 10,
              min: 1,
              type: "number",
            }
          )}
          ${textField(
            "successThreshold",
            "Up after N successes",
            values.successThreshold,
            {
              max: 10,
              min: 1,
              type: "number",
            }
          )}
        </div>
        ${channelPicker(values, data.channels)}
        <div class="row">
          ${checkbox("enabled", "Enabled", values.enabled)}
          ${checkbox("public", "Show on the public status page", values.public)}
        </div>
        ${
          isNew &&
          html`<details>
            <summary class="small muted">Advanced</summary>
            <div style="margin-top:.75rem">
              ${textField("key", "Key", values.key, {
                hint: "Stable identifier for config-as-code; defaults to the id.",
              })}
            </div>
          </details>`
        }
        <div>
          <button type="submit" class="primary">
            ${isNew ? "Create monitor" : "Save changes"}
          </button>
        </div>
      </form>`,
    section: "dashboard",
    title,
  });
};

// ---------------------------------------------------------------------------
// Channels

export interface ChannelsData {
  readonly channels: readonly ChannelView[];
  readonly flash: Flash | null;
  /** The channel whose form failed, and the submitted values. */
  readonly formError: {
    readonly channelId: string | null;
    readonly message: string;
    readonly values: FormFields;
  } | null;
  readonly testResult: {
    readonly channelId: string;
    readonly result: ChannelTestResult;
  } | null;
}

const channelKinds: readonly ChannelKind[] = [
  "slack",
  "discord",
  "webhook",
  "ntfy",
];

const kindSelect = (id: string, value: string): Html => html`<select
  id="${id}"
  name="kind"
>
  ${channelKinds.map(
    (kind) =>
      html`<option value="${kind}" ${value === kind && html`selected`}>
        ${kind}
      </option>`
  )}
</select>`;

const testResultBox = (result: ChannelTestResult): Html =>
  result.delivered
    ? html`<div class="flash ok">
        Test alert delivered (HTTP ${result.status ?? "?"}).
      </div>`
    : html`<div class="flash error">
        Test alert
        failed${result.status !== null && ` (HTTP ${result.status})`}:
        ${result.error ?? "unknown error"}
      </div>`;

const channelRow = (channel: ChannelView, data: ChannelsData): Html => {
  const path = `/channels/${encodeURIComponent(channel.id)}`;
  const failed =
    data.formError !== null && data.formError.channelId === channel.id
      ? data.formError
      : null;
  const value = (name: string, fallback: string) =>
    failed === null
      ? fallback
      : (failed.values.find(([key]) => key === name)?.[1] ?? "");
  const testResult =
    data.testResult?.channelId === channel.id ? data.testResult.result : null;
  return html`<div class="panel stack" id="channel-${channel.id}">
    <div class="row spread">
      <div>
        <strong>${channel.name}</strong>
        <span class="badge">${channel.kind}</span>
        ${channel.managed && html`<span class="badge">managed by config</span>`}
        <div class="mono muted">${channel.maskedUrl}</div>
      </div>
      <div class="row">
        ${postButton(`${path}/test`, "Send test alert")}
        ${postButton(`${path}/delete`, "Delete", {
          className: "danger",
          confirm: `Delete channel "${channel.name}"? Monitors stop alerting it.`,
        })}
      </div>
    </div>
    ${testResult !== null && testResultBox(testResult)}
    ${failed !== null && flashBox({ kind: "error", text: failed.message })}
    <details ${failed !== null && html`open`}>
      <summary class="small">Edit</summary>
      ${channel.managed && managedWarning("channel")}
      <form
        method="post"
        action="${path}"
        class="stack"
        style="margin-top:.75rem"
      >
        <div class="grid">
          ${textField("name", "Name", value("name", channel.name), {
            id: `name-${channel.id}`,
            required: true,
          })}
          <div class="field">
            <label for="kind-${channel.id}">Kind</label>
            ${kindSelect(`kind-${channel.id}`, value("kind", channel.kind))}
          </div>
        </div>
        ${textField("url", "New URL", "", {
          hint: "Leave empty to keep the current URL (it is never shown).",
          id: `url-${channel.id}`,
          placeholder: channel.maskedUrl,
          type: "url",
        })}
        <div><button type="submit" class="primary">Save</button></div>
      </form>
    </details>
  </div>`;
};

export const channelsPage = (data: ChannelsData): Html => {
  const createError =
    data.formError !== null && data.formError.channelId === null
      ? data.formError
      : null;
  const value = (name: string, fallback = "") =>
    createError === null
      ? fallback
      : (createError.values.find(([key]) => key === name)?.[1] ?? "");
  return page({
    body: html`${flashBox(data.flash)}
      <h1>Alert channels</h1>
      <p class="muted">
        Monitors alert every channel unless they list specific ones. URLs are
        secrets: they are stored but never shown again.
      </p>
      <div class="stack">
        ${
          data.channels.length === 0
            ? html`<div class="panel empty">No channels yet.</div>`
            : data.channels.map((channel) => channelRow(channel, data))
        }
      </div>
      <h2>Add a channel</h2>
      ${
        createError !== null &&
        flashBox({ kind: "error", text: createError.message })
      }
      <form method="post" action="/channels" class="panel stack">
        <div class="grid">
          ${textField("name", "Name", value("name"), { required: true })}
          <div class="field">
            <label for="kind-new">Kind</label>
            ${kindSelect("kind-new", value("kind", "slack"))}
          </div>
        </div>
        ${textField("url", "Webhook URL", value("url"), {
          hint: "Slack/Discord incoming webhook, a generic webhook, or an ntfy topic URL (https).",
          required: true,
          type: "url",
        })}
        <details>
          <summary class="small muted">Advanced</summary>
          <div style="margin-top:.75rem">
            ${textField("key", "Key", value("key"), {
              hint: "Stable identifier for config-as-code; defaults to the id.",
            })}
          </div>
        </details>
        <div><button type="submit" class="primary">Add channel</button></div>
      </form>`,
    section: "channels",
    title: "Channels",
  });
};

// ---------------------------------------------------------------------------
// Errors

export const notFoundPage = (signedIn: boolean): Html =>
  page({
    body: html`<div class="panel empty">
      <h1>Not found</h1>
      <p><a href="${signedIn ? "/" : "/status"}">Go back</a></p>
    </div>`,
    section: signedIn ? "dashboard" : null,
    title: "Not found",
  });

export const forbiddenPage = (): Html =>
  page({
    body: html`<div class="panel empty">
      <h1>Forbidden</h1>
      <p>This form was not submitted from this site.</p>
    </div>`,
    title: "Forbidden",
  });
