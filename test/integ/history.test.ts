// Integration tests for history: the checks, uptime and incidents endpoints
// for a monitor that went through a down/up cycle with real alarms, and
// maintenance (rollups, retention) driven through the dev hook
// `POST /_dev/monitors/:id/maintain?now=`. Run with `pnpm test:integ`.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";

import type { ChannelView } from "../../src/domain/channel.ts";
import type {
  Check,
  IncidentWithAlerts,
  UptimeReport,
} from "../../src/domain/history.ts";
import { dayMs, dayOf, dayStart } from "../../src/monitor/history.ts";
import type { MaintenanceResult } from "../../src/monitor/monitor.ts";
import type { Detail } from "./harness.ts";
import { setup, statusOf, waitFor } from "./harness.ts";

interface AlertsDetail extends Detail {
  readonly alerts: {
    readonly notifications: readonly unknown[];
    readonly outbox: readonly unknown[];
    readonly recipients: readonly unknown[];
  };
}

const { create, detail, devUrl, send, setFlip, test } = setup("integ-history");

/** `GET /checks`: newest first, `limit` and `since`, bad input rejected. */
const expectChecksEndpoint = Effect.fn("expectChecksEndpoint")(
  function* expectChecksEndpointEffect(base: string) {
    // Checks: newest first; the unconfirmed failure is stored uncounted.
    const checksReply = yield* send("GET", `${base}/checks`);
    expect(checksReply.status).toBe(200);
    const checks = checksReply.body as readonly Check[];
    expect(checks.length).toBeGreaterThanOrEqual(4);
    const times = checks.map((check) => check.at);
    expect(times).toEqual(times.toSorted((left, right) => right - left));
    const failures = checks.filter((check) => !check.ok);
    expect(failures.some((check) => !check.counted)).toBe(true);
    expect(
      failures.some((check) => check.counted && check.kind === "confirm")
    ).toBe(true);
    const limited = (yield* send("GET", `${base}/checks?limit=2`))
      .body as readonly Check[];
    expect(limited).toHaveLength(2);
    expect(limited[0]?.checkId).toBe(checks[0]?.checkId);
    const since = checks[1]?.at ?? 0;
    const recent = (yield* send("GET", `${base}/checks?since=${since}`))
      .body as readonly Check[];
    expect(recent.every((check) => check.at >= since)).toBe(true);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect((yield* send("GET", `${base}/checks?limit=0`)).status).toBe(400);
    expect((yield* send("GET", `${base}/checks?since=abc`)).status).toBe(400);
    return checks;
  }
);

test(
  "checks, uptime and incidents for a monitor that went down and recovered; maintenance rolls up and prunes",
  Effect.gen(function* historyTest() {
    // A channel, so the incident has alert rows to show and to prune.
    const channel = yield* send("POST", "/api/channels", {
      body: {
        kind: "webhook",
        name: "history sink",
        url: yield* devUrl("/webhook?tag=history"),
      },
    });
    expect(channel.status).toBe(201);

    const flip = `history-${crypto.randomUUID()}`;
    const monitor = yield* create({
      intervalSeconds: 5,
      url: yield* devUrl(`/target/flip/${flip}`),
    });
    const base = `/api/monitors/${monitor.id}`;
    yield* waitFor("up", detail(monitor.id), (d) => statusOf(d) === "up");
    yield* setFlip(flip, false);
    yield* waitFor("down", detail(monitor.id), (d) => statusOf(d) === "down");
    yield* setFlip(flip, true);
    yield* waitFor(
      "recovered",
      detail(monitor.id),
      (d) => statusOf(d) === "up"
    );

    // Incidents, with the down and up alert rows once delivered.
    const incidentsReply = yield* waitFor(
      "alerts delivered",
      send("GET", `${base}/incidents`),
      (reply) => {
        const [incident] = reply.body as readonly IncidentWithAlerts[];
        return (
          incident?.alerts.length === 2 &&
          incident.alerts.every((alert) => alert.state === "delivered")
        );
      }
    );
    const incidents = incidentsReply.body as readonly IncidentWithAlerts[];
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.resolution).toBe("recovered");
    expect(incidents[0]?.resolvedAt).toBeNumber();
    expect(incidents[0]?.alerts.map((alert) => alert.event).toSorted()).toEqual(
      ["down", "up"]
    );

    const checks = yield* expectChecksEndpoint(base);

    // Stop checking so the counts below are stable.
    yield* send("PATCH", base, { body: { enabled: false } });
    const today = dayOf(Date.now());

    // Uptime: only today (created today), computed live from counted
    // samples.
    const live = (yield* send("GET", `${base}/uptime?days=90`))
      .body as UptimeReport;
    const counted = checks.filter((check) => check.counted);
    expect(live.days).toHaveLength(1);
    const [liveDay] = live.days;
    expect(liveDay?.day).toBe(today);
    expect(liveDay?.live).toBe(true);
    expect(liveDay?.counted).toBeGreaterThanOrEqual(counted.length);
    expect(liveDay?.down).toBeGreaterThanOrEqual(1);
    expect(liveDay?.up).toBeGreaterThanOrEqual(2);
    expect(liveDay?.expected).toBeGreaterThan(0);
    expect(typeof liveDay?.partial).toBe("boolean");
    expect(liveDay?.p50).toBeNumber();
    expect(live.uptimePercent).toBeGreaterThan(0);
    expect(live.uptimePercent).toBeLessThan(100);
    expect(live.counted).toBe(liveDay?.counted ?? -1);
    expect((yield* send("GET", `${base}/uptime?days=0`)).status).toBe(400);

    const maintain = (now: number) =>
      send("POST", `/_dev/monitors/${monitor.id}/maintain?now=${now}`, {
        auth: null,
      }).pipe(
        Effect.map((reply) => {
          expect(reply.status).toBe(200);
          return reply.body as MaintenanceResult;
        })
      );
    const tomorrow = dayStart(today) + dayMs;

    // After midnight: today is rolled up and the watermark advances; raw
    // checks are kept (not 30 days old).
    const first = yield* maintain(tomorrow + 60_000);
    expect(first.rolledUp).toEqual([today]);
    expect(first.rolledUpThrough).toBe(today);
    expect(first.pruned.checks).toBe(0);
    const rolled = (yield* send("GET", `${base}/uptime`)).body as UptimeReport;
    expect(rolled.days).toHaveLength(1);
    // The rollup matches what was computed live (the monitor is disabled,
    // so its enabled period, and with it `expected`, has ended).
    expect(rolled.days[0]).toEqual({ ...liveDay, live: false } as never);

    // 40 days later: raw checks are pruned (rolled up and older than 30
    // days), the rollup and the incident (90 days) stay. 31 days per run.
    const second = yield* maintain(tomorrow + 40 * dayMs);
    expect(second.rolledUp).toHaveLength(31);
    expect(second.pruned.checks).toBeGreaterThanOrEqual(checks.length);
    expect((yield* send("GET", `${base}/checks`)).body).toEqual([]);
    const afterPrune = (yield* send("GET", `${base}/uptime`))
      .body as UptimeReport;
    expect(afterPrune.days[0]?.counted).toBe(rolled.days[0]?.counted ?? -1);
    expect(
      (yield* send("GET", `${base}/incidents`)).body as readonly unknown[]
    ).toHaveLength(1);

    // 100 days later: the resolved incident and its alert rows go too.
    const third = yield* maintain(tomorrow + 100 * dayMs);
    expect(third.pruned.incidents).toBe(1);
    expect((yield* send("GET", `${base}/incidents`)).body).toEqual([]);
    const raw = yield* detail<AlertsDetail>(monitor.id);
    expect(raw.alerts.notifications).toEqual([]);
    expect(raw.alerts.outbox).toEqual([]);
    expect(raw.alerts.recipients).toEqual([]);

    // Unknown monitors.
    for (const path of ["checks", "uptime", "incidents"]) {
      expect((yield* send("GET", `/api/monitors/missing/${path}`)).status).toBe(
        404
      );
    }
    expect(
      (yield* send("POST", "/_dev/monitors/missing/maintain", { auth: null }))
        .status
    ).toBe(404);

    yield* send("DELETE", base);
    yield* send("DELETE", `/api/channels/${(channel.body as ChannelView).id}`);
  }),
  { timeout: 120_000 }
);
