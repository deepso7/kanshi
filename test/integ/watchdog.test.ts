// Integration tests for the watchdog: re-arming lost alarms, finishing or
// cleaning up stuck creates and deletes, converging summaries and the "not
// being checked" alert. The watchdog is run on demand with
// `POST /_dev/watchdog?now=<ms>` instead of waiting for the cron. Run with
// `pnpm test:integ`.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";

import {
  MonitorListItem,
  MonitorResponse,
  Overview,
} from "../../src/api/spec.ts";
import { OutboxEntry } from "../../src/domain/alert.ts";
import { ChannelView } from "../../src/domain/channel.ts";
import { Episode } from "../../src/domain/watchdog.ts";
import { watchdogCron } from "../../src/worker.ts";
import {
  SinkEvent,
  WebhookAlert,
  bodyOf,
  callsSince,
  setup,
  waitFor,
} from "./harness.ts";

const {
  create,
  detail,
  devUrl,
  registryCalls,
  registryRows,
  send,
  stack,
  test,
} = setup("integ-watchdog");

const minute = 60_000;

/** `RowReport`: what the watchdog did with one Registry row. */
const RowReport = Schema.Struct({
  action: Schema.String,
  alarmAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  errors: Schema.Array(Schema.String),
  id: Schema.String,
  lifecycle: Schema.String,
  outcome: Schema.String,
  summaryUpdated: Schema.optionalKey(Schema.Boolean),
  suspect: Schema.optionalKey(Schema.Boolean),
  watch: Schema.optionalKey(
    Schema.Struct({
      applied: Schema.Boolean,
      change: Schema.String,
      episodeId: Schema.NullOr(Schema.String),
    })
  ),
});
type RowReport = typeof RowReport.Type;

/** `WatchdogReport`, as `POST /_dev/watchdog` returns it. */
const WatchdogReport = Schema.Struct({
  failed: Schema.Number,
  now: Schema.Number,
  pruned: Schema.NullOr(Schema.Number),
  registryAlarmAt: Schema.NullOr(Schema.Number),
  results: Schema.Array(RowReport),
});
type WatchdogReport = typeof WatchdogReport.Type;

/** `WatchdogAlertsView`, as `GET /_dev/watchdog` returns it. */
const WatchdogAlertsView = Schema.Struct({
  episodes: Schema.Array(Episode),
  outbox: Schema.Array(OutboxEntry),
});

/** Run the watchdog once, as of `now` (default: the current time). */
const watchdog = (now?: number) =>
  send("POST", `/_dev/watchdog${now === undefined ? "" : `?now=${now}`}`).pipe(
    Effect.flatMap((reply) => {
      expect(reply.status).toBe(200);
      return bodyOf(WatchdogReport)(reply);
    })
  );

/** The report for `id`; the expectation fails when there is none. */
const resultFor = (
  report: WatchdogReport,
  id: string
): RowReport | undefined => {
  const result = report.results.find((entry) => entry.id === id);
  expect(result).toBeDefined();
  return result;
};

/**
 * The confirming writes a run makes: one when any row was a suspect (for
 * all of them), none otherwise.
 */
const confirmingWrites = (report: WatchdogReport): number =>
  report.results.some((result) => result.suspect === true) ? 1 : 0;

const rowOf = (id: string) =>
  registryRows.pipe(
    Effect.map((rows) => rows.find((entry) => entry.id === id) ?? null)
  );

const lastCheckedAt = (id: string) =>
  detail(id).pipe(
    Effect.map((value) => value.status.snapshot?.state.lastCheckedAt ?? null)
  );

const remove = Effect.fn("Test.remove")(function* removeMonitor(id: string) {
  const reply = yield* send("DELETE", `/api/monitors/${id}`);
  expect(reply.status).toBe(204);
});

test(
  "re-arms a monitor whose alarm was lost",
  Effect.gen(function* rearmTest() {
    const monitor = yield* create({
      intervalSeconds: 5,
      url: yield* devUrl("/target"),
    });
    yield* waitFor(
      "first check",
      lastCheckedAt(monitor.id),
      (at) => at !== null
    );

    // Clear the alarm; retry if a running alarm re-armed it meanwhile.
    yield* waitFor(
      "alarm cleared",
      send("POST", `/_dev/monitors/${monitor.id}/clear-alarm`).pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(detail(monitor.id))
      ),
      (value) => value.status.alarmAt === null
    );
    const stoppedAt = yield* lastCheckedAt(monitor.id);
    yield* Effect.sleep("7 seconds");
    const stopped = yield* detail(monitor.id);
    expect(stopped.status.alarmAt).toBeNull();
    expect(stopped.status.snapshot?.state.lastCheckedAt).toBe(stoppedAt);

    // Run as of an hour on, so the monitor counts as stale: its alarm is
    // restored, but it is not alerted in the same run (checks resume on
    // the restored alarm before anyone would read the alert).
    const later = Date.now() + 60 * minute;
    const before = yield* registryCalls;
    const report = yield* watchdog(later);
    const after = yield* registryCalls;
    const result = resultFor(report, monitor.id);
    expect(result?.action).toBe("Refresh");
    expect(result?.errors).toEqual([]);
    expect(result?.alarmAt).toBeNumber();
    expect(result?.watch).toMatchObject({ applied: true, change: "none" });
    expect(result?.suspect).toBeUndefined();
    // One list and one batched write, whatever the number of monitors; no
    // per-monitor Registry call, and no confirming write without a suspect.
    expect(callsSince(before, after, "list")).toBe(1);
    expect(callsSince(before, after, "reconcile")).toBe(1);
    expect(callsSince(before, after, "confirmStale")).toBe(
      confirmingWrites(report)
    );
    expect(callsSince(before, after, "upsertSummary")).toBe(0);
    expect((yield* detail(monitor.id)).status.alarmAt).toBeNumber();
    yield* waitFor(
      "checks resume",
      lastCheckedAt(monitor.id),
      (at) => at !== null && stoppedAt !== null && at > stoppedAt,
      15_000
    );
    // Still stale as of that time with its alarm in place: a suspect of
    // the batch, confirmed by a fresh read, so alerted now.
    const beforeNext = yield* registryCalls;
    const next = resultFor(yield* watchdog(later), monitor.id);
    const afterNext = yield* registryCalls;
    expect(next?.suspect).toBe(true);
    expect(next?.watch).toMatchObject({ applied: true, change: "open" });
    expect(callsSince(beforeNext, afterNext, "list")).toBe(1);
    expect(callsSince(beforeNext, afterNext, "reconcile")).toBe(1);
    expect(callsSince(beforeNext, afterNext, "confirmStale")).toBe(1);
    const resumed = resultFor(yield* watchdog(), monitor.id);
    expect(resumed?.watch).toMatchObject({ change: "resolve" });
    yield* remove(monitor.id);
  }),
  { timeout: 60_000 }
);

test(
  "activates a stuck create whose monitor was configured",
  Effect.gen(function* stuckActivateTest() {
    const monitor = yield* send("POST", "/api/monitors", {
      body: { enabled: false, name: "stuck", url: yield* devUrl("/target") },
      headers: { "x-kanshi-dev-skip-activate": "1" },
    }).pipe(
      Effect.flatMap((reply) => {
        expect(reply.status).toBe(201);
        return bodyOf(MonitorResponse)(reply);
      })
    );
    expect((yield* rowOf(monitor.id))?.lifecycle).toBe("creating");
    expect((yield* send("GET", `/api/monitors/${monitor.id}`)).status).toBe(
      404
    );

    // Younger than five minutes: left alone.
    const early = yield* watchdog();
    expect(resultFor(early, monitor.id)?.action).toBe("Wait");
    expect((yield* rowOf(monitor.id))?.lifecycle).toBe("creating");

    const late = yield* watchdog(Date.now() + 6 * minute);
    expect(resultFor(late, monitor.id)).toMatchObject({
      action: "Activate",
      outcome: "activated",
    });
    expect((yield* rowOf(monitor.id))?.lifecycle).toBe("active");
    const fetched = yield* send("GET", `/api/monitors/${monitor.id}`);
    expect(fetched.status).toBe(200);
    expect((yield* bodyOf(MonitorResponse)(fetched)).name).toBe("stuck");
    yield* remove(monitor.id);
  }),
  { timeout: 60_000 }
);

test(
  "removes a stuck create whose monitor was never configured, and a late configure cannot arm it",
  Effect.gen(function* stuckAbandonTest() {
    const name = `abandoned-${crypto.randomUUID()}`;
    const creating = yield* send("POST", "/api/monitors", {
      body: {
        intervalSeconds: 5,
        name,
        url: yield* devUrl("/target"),
      },
      headers: { "x-kanshi-dev-configure-delay": "4000" },
    }).pipe(Effect.forkChild({ startImmediately: true }));

    const rows = yield* waitFor("creating row", registryRows, (entries) =>
      entries.some((row) => row.summary.name === name)
    );
    const id = rows.find((row) => row.summary.name === name)?.id ?? "";
    expect((yield* detail(id)).status.snapshot).toBeNull();

    const report = yield* watchdog(Date.now() + 6 * minute);
    expect(resultFor(report, id)).toMatchObject({
      action: "Abandon",
      outcome: "removed",
    });
    expect(yield* rowOf(id)).toBeNull();

    // The delayed configure hits the tombstone.
    expect((yield* Fiber.join(creating)).status).toBe(409);
    const gone = yield* detail(id);
    expect(gone.status.tombstonedAt).toBeNumber();
    expect(gone.status.snapshot).toBeNull();
    expect(gone.status.alarmAt).toBeNull();
    yield* Effect.sleep("6 seconds");
    expect((yield* detail(id)).checks).toHaveLength(0);
  }),
  { timeout: 60_000 }
);

test(
  "finishes a stuck delete",
  Effect.gen(function* stuckDeleteTest() {
    const monitor = yield* create({
      intervalSeconds: 5,
      url: yield* devUrl("/target"),
    });
    const marked = yield* send(
      "POST",
      `/_dev/registry/${monitor.id}/mark-deleting`
    );
    expect(marked.body).toEqual({ marked: true });
    expect((yield* rowOf(monitor.id))?.lifecycle).toBe("deleting");
    expect((yield* send("GET", `/api/monitors/${monitor.id}`)).status).toBe(
      404
    );
    expect((yield* detail(monitor.id)).status.snapshot).not.toBeNull();

    const report = yield* watchdog();
    expect(resultFor(report, monitor.id)).toMatchObject({
      action: "Destroy",
      outcome: "removed",
    });
    expect(yield* rowOf(monitor.id)).toBeNull();
    const gone = yield* detail(monitor.id);
    expect(gone.status.tombstonedAt).toBeNumber();
    expect(gone.status.snapshot).toBeNull();
    expect(gone.status.alarmAt).toBeNull();
  }),
  { timeout: 60_000 }
);

test(
  "the cron trigger runs the watchdog",
  Effect.gen(function* cronTest() {
    const monitor = yield* create({
      enabled: false,
      url: yield* devUrl("/target"),
    });
    yield* send("POST", `/_dev/registry/${monitor.id}/mark-deleting`);
    // Locally, the cron can be fired on demand.
    const { url } = yield* stack;
    const fired = yield* HttpClient.post(
      `${url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(watchdogCron)}&time=${Date.now()}`
    );
    expect(fired.status).toBe(200);
    yield* waitFor(
      "row removed by the cron",
      rowOf(monitor.id),
      (row) => row === null
    );
    expect((yield* detail(monitor.id)).status.tombstonedAt).toBeNumber();
  }),
  { timeout: 60_000 }
);

test(
  "converges a summary whose pushes were lost, for a disabled monitor too",
  Effect.gen(function* convergeTest() {
    const target = yield* devUrl("/target");
    const monitor = yield* create({
      enabled: false,
      name: "converge",
      url: target,
    });
    const rewound = yield* send("POST", `/_dev/registry/${monitor.id}/rewind`);
    expect(rewound.body).toEqual({ rewound: true });

    const listed = () =>
      send("GET", "/api/monitors").pipe(
        Effect.flatMap(bodyOf(Schema.Array(MonitorListItem))),
        Effect.map(
          (items) => items.find((item) => item.id === monitor.id) ?? null
        )
      );
    expect(yield* listed()).toMatchObject({ name: "(stale)", url: "" });

    const report = yield* watchdog();
    expect(resultFor(report, monitor.id)).toMatchObject({
      action: "Refresh",
      summaryUpdated: true,
    });
    expect(yield* listed()).toMatchObject({
      enabled: false,
      name: "converge",
      status: "unknown",
      url: target,
    });
    const row = yield* rowOf(monitor.id);
    expect(row?.summaryRevision).toBe(monitor.state.summaryRevision);

    // Not newer: the next run leaves it alone.
    const again = yield* watchdog();
    expect(resultFor(again, monitor.id)?.summaryUpdated).toBe(false);
    yield* remove(monitor.id);
  }),
  { timeout: 60_000 }
);

/** `GET /api/watchdog/episodes`: the open episodes. */
const openEpisodes = send("GET", "/api/watchdog/episodes").pipe(
  Effect.flatMap((reply) => {
    expect(reply.status).toBe(200);
    return bodyOf(Schema.Array(Episode))(reply);
  })
);

/** `notChecked` in the monitor's detail, list item and overview row. */
const notCheckedFlags = (id: string) =>
  Effect.all([
    send("GET", `/api/monitors/${id}`).pipe(
      Effect.flatMap(bodyOf(MonitorResponse)),
      Effect.map((monitor) => monitor.notChecked)
    ),
    send("GET", "/api/monitors").pipe(
      Effect.flatMap(bodyOf(Schema.Array(MonitorListItem))),
      Effect.map((items) => items.find((item) => item.id === id)?.notChecked)
    ),
    send("GET", "/api/overview").pipe(
      Effect.flatMap(bodyOf(Overview)),
      Effect.map(
        (overview) =>
          overview.monitors.find((item) => item.id === id)?.notChecked
      )
    ),
  ]);

/** Webhook alerts the sink received for `tag` about `monitorId`. */
const alertsAbout = (tag: string, monitorId: string) =>
  send("GET", "/_dev/events").pipe(
    Effect.flatMap(bodyOf(Schema.Array(SinkEvent))),
    Effect.map((events) =>
      events.filter((event) =>
        new URLSearchParams(event.detail.query).getAll("tag").includes(tag)
      )
    ),
    Effect.flatMap(
      Effect.forEach((event) =>
        Schema.decodeUnknownEffect(WebhookAlert)(event.detail.body)
      )
    ),
    Effect.map((alerts) =>
      alerts.filter((alert) => alert.monitor?.id === monitorId)
    )
  );

test(
  "alerts once when a monitor is not being checked, then when checks resume",
  Effect.gen(function* notCheckedTest() {
    const tag = `watchdog-${crypto.randomUUID()}`;
    const channel = yield* send("POST", "/api/channels", {
      body: {
        kind: "webhook",
        name: "watchdog sink",
        url: yield* devUrl(`/webhook?tag=${tag}`),
      },
    }).pipe(Effect.flatMap(bodyOf(ChannelView)));
    const monitor = yield* create({
      intervalSeconds: 5,
      name: "watched",
      url: yield* devUrl("/target"),
    });
    yield* waitFor(
      "first check",
      lastCheckedAt(monitor.id),
      (at) => at !== null
    );

    // An hour on, the last check is far older than the 10 minute floor:
    // one stale observation opens the episode.
    // The batch only reports it; the confirming write, after a fresh read
    // of the monitor, opens it.
    const later = Date.now() + 60 * minute;
    const before = yield* registryCalls;
    const first = resultFor(yield* watchdog(later), monitor.id);
    const after = yield* registryCalls;
    expect(first?.suspect).toBe(true);
    expect(first?.watch).toMatchObject({ applied: true, change: "open" });
    expect(callsSince(before, after, "reconcile")).toBe(1);
    expect(callsSince(before, after, "confirmStale")).toBe(1);
    const episodeId = first?.watch?.episodeId ?? "";
    expect(episodeId).toStartWith("watchdog-");
    expect((yield* rowOf(monitor.id))?.watch).toEqual({ episodeId });
    // The API shows the open episode and flags the monitor.
    const open = yield* openEpisodes;
    expect(open.find((entry) => entry.id === episodeId)).toMatchObject({
      monitorId: monitor.id,
      monitorName: "watched",
      resolvedAt: null,
    });
    expect(yield* notCheckedFlags(monitor.id)).toEqual([true, true, true]);
    // Still stale: deduplicated, no second alert, and no suspect (the
    // episode is open), so no confirming write.
    const beforeAgain = yield* registryCalls;
    const againReport = yield* watchdog(later);
    const afterAgain = yield* registryCalls;
    const again = resultFor(againReport, monitor.id);
    expect(again?.watch).toMatchObject({ change: "none", episodeId });
    expect(again?.suspect).toBeUndefined();
    expect(callsSince(beforeAgain, afterAgain, "confirmStale")).toBe(
      confirmingWrites(againReport)
    );

    const down = yield* waitFor(
      "not-being-checked alert",
      alertsAbout(tag, monitor.id),
      (alerts) => alerts.some((alert) => alert.event === "not_checked")
    );
    expect(down.filter((alert) => alert.event === "not_checked")).toHaveLength(
      1
    );
    expect(down[0]?.title).toBe("monitor watched is not being checked");
    expect(down[0]?.id).toBe(`${episodeId}:down:${channel.id}`);

    // Checks are recent at the real time: the episode resolves.
    const resumed = resultFor(yield* watchdog(), monitor.id);
    expect(resumed?.watch).toMatchObject({
      change: "resolve",
      episodeId: null,
    });
    expect((yield* openEpisodes).some((entry) => entry.id === episodeId)).toBe(
      false
    );
    expect(yield* notCheckedFlags(monitor.id)).toEqual([false, false, false]);
    const all = yield* waitFor(
      "checked-again alert",
      alertsAbout(tag, monitor.id),
      (alerts) => alerts.some((alert) => alert.event === "checked")
    );
    expect(all.map((alert) => alert.event)).toEqual(["not_checked", "checked"]);
    expect(all[1]?.id).toBe(`${episodeId}:up:${channel.id}`);

    const view = yield* bodyOf(WatchdogAlertsView)(
      yield* send("GET", "/_dev/watchdog")
    );
    const episode = view.episodes.find((entry) => entry.id === episodeId);
    expect(episode).toMatchObject({
      monitorId: monitor.id,
      resolution: "recovered",
    });
    expect(
      view.outbox
        .filter((entry) => entry.incidentId === episodeId)
        .map((entry) => [entry.event, entry.state])
        .toSorted()
    ).toEqual([
      ["down", "delivered"],
      ["up", "delivered"],
    ]);

    yield* remove(monitor.id);
    expect((yield* send("DELETE", `/api/channels/${channel.id}`)).status).toBe(
      204
    );
  }),
  { timeout: 90_000 }
);

test(
  "converges a lost status push that later checks do not repeat",
  Effect.gen(function* lostPushTest() {
    const target = yield* devUrl("/target");
    const monitor = yield* create({
      intervalSeconds: 5,
      name: "lost push",
      url: target,
    });
    const listed = send("GET", "/api/monitors").pipe(
      Effect.flatMap(bodyOf(Schema.Array(MonitorListItem))),
      Effect.map((items) => items.find((item) => item.id === monitor.id))
    );
    yield* waitFor(
      "up in the Registry",
      listed,
      (item) => item?.status === "up"
    );

    // As if the up push had been lost: the Registry still says unknown.
    yield* send("POST", `/_dev/registry/${monitor.id}/rewind`);
    const checks = detail(monitor.id).pipe(
      Effect.map((value) => value.checks.length)
    );
    const start = yield* checks;
    yield* waitFor("two more checks", checks, (count) => count >= start + 2);
    // Nothing changed for the monitor, so nothing was pushed.
    expect(yield* listed).toMatchObject({ name: "(stale)", status: "unknown" });

    const report = yield* watchdog();
    expect(resultFor(report, monitor.id)).toMatchObject({
      action: "Refresh",
      summaryUpdated: true,
    });
    expect(yield* listed).toMatchObject({
      name: "lost push",
      status: "up",
      url: target,
    });
    yield* remove(monitor.id);
  }),
  { timeout: 60_000 }
);
