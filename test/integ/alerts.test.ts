// Integration tests for alerts: channels, notifications and the outbox,
// driven by real alarms at 5s intervals against the `/_dev/target` fixtures
// and the `/_dev/webhook` sink. Run with `pnpm test:integ`.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ChannelTestResult } from "../../src/api/spec.ts";
import type { ChannelCreateInput } from "../../src/domain/channel.ts";
import { ChannelView } from "../../src/domain/channel.ts";
import {
  ErrorBody,
  SinkEvent,
  WebhookAlert,
  bodyOf,
  setup,
  statusOf,
  waitFor,
} from "./harness.ts";

const { create, detail, devUrl, send, setFlip, test } = setup("integ-alerts");

/** A sink URL whose events can be told apart by `tag`. */
const sinkUrl = (tag: string, query = "") =>
  devUrl(`/webhook?tag=${tag}${query}`);

/** A webhook alert as received by the sink. */
interface Received {
  readonly event: (typeof WebhookAlert.Type)["event"];
  readonly id: string;
  readonly idempotencyKey: string | null;
  readonly recovered: boolean;
  readonly respondedWith: number;
  readonly title: string;
}

/** Webhook alerts the sink received for `tag`, oldest first. */
const received = (tag: string) =>
  send("GET", "/_dev/events").pipe(
    Effect.flatMap(bodyOf(Schema.Array(SinkEvent))),
    Effect.map((events) =>
      events.filter((event) =>
        new URLSearchParams(event.detail.query).getAll("tag").includes(tag)
      )
    ),
    Effect.flatMap(
      Effect.forEach((event) =>
        Schema.decodeUnknownEffect(WebhookAlert)(event.detail.body).pipe(
          Effect.map(
            (body) =>
              ({
                event: body.event,
                id: body.id,
                idempotencyKey: event.detail.idempotencyKey,
                recovered: body.recovered,
                respondedWith: event.detail.respondedWith,
                title: body.title,
              }) satisfies Received
          )
        )
      )
    )
  );

const createChannel = Effect.fn("Test.createChannel")(function* createChannel(
  body: Partial<typeof ChannelCreateInput.Encoded>
) {
  const reply = yield* send("POST", "/api/channels", {
    body: { kind: "webhook", name: "integration channel", ...body },
  });
  expect(reply.status).toBe(201);
  return yield* bodyOf(ChannelView)(reply);
});

test(
  "channel URLs are write-only: masked, never returned",
  Effect.gen(function* channelSecrecyTest() {
    const secret = `secret-${crypto.randomUUID()}`;
    const url = yield* sinkUrl(secret);
    const channel = yield* createChannel({ url });
    expect(channel.maskedUrl).toStartWith("http://localhost:");
    expect(channel.maskedUrl).not.toContain(secret);

    const listed = yield* send("GET", "/api/channels");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(
      (yield* bodyOf(Schema.Array(ChannelView))(listed)).some(
        (c) => c.id === channel.id
      )
    ).toBe(true);

    // The URL is replaceable; the new one is not readable either.
    const replacement = yield* sinkUrl(`replaced-${secret}`);
    const patched = yield* send("PATCH", `/api/channels/${channel.id}`, {
      body: { name: "renamed", url: replacement },
    });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.body)).not.toContain(secret);
    const patchedView = yield* bodyOf(ChannelView)(patched);
    expect(patchedView.name).toBe("renamed");

    // Validation: https only outside loopback, known ids.
    const insecure = yield* send("POST", "/api/channels", {
      body: { kind: "slack", name: "x", url: "http://example.com/hook" },
    });
    expect(insecure.status).toBe(400);
    const unknownChannel = yield* send("POST", "/api/monitors", {
      body: {
        channels: [channel.id, "missing-channel"],
        name: "x",
        url: yield* devUrl("/target"),
      },
    });
    expect(unknownChannel.status).toBe(400);
    expect((yield* bodyOf(ErrorBody)(unknownChannel)).message).toContain(
      "missing-channel"
    );
    const monitor = yield* create({
      channels: [channel.id],
      enabled: false,
      url: yield* devUrl("/target"),
    });
    expect(monitor.channels).toEqual([channel.id]);
    const badPatch = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { channels: ["missing-channel"] },
    });
    expect(badPatch.status).toBe(400);
    yield* send("DELETE", `/api/monitors/${monitor.id}`);

    expect((yield* send("DELETE", `/api/channels/${channel.id}`)).status).toBe(
      204
    );
    expect((yield* send("DELETE", `/api/channels/${channel.id}`)).status).toBe(
      404
    );
    expect(
      (yield* send("PATCH", `/api/channels/${channel.id}`, {
        body: { name: "x" },
      })).status
    ).toBe(404);
  }),
  { timeout: 60_000 }
);

test(
  "the test endpoint sends a test alert and reports the result",
  Effect.gen(function* channelTestEndpointTest() {
    const tag = crypto.randomUUID();
    const channel = yield* createChannel({ url: yield* sinkUrl(tag) });
    const reply = yield* send("POST", `/api/channels/${channel.id}/test`);
    expect(reply.status).toBe(200);
    expect(yield* bodyOf(ChannelTestResult)(reply)).toEqual({
      delivered: true,
      error: null,
      status: 200,
    });
    const [event, ...rest] = yield* received(tag);
    expect(rest).toHaveLength(0);
    expect(event?.event).toBe("test");
    expect(event?.idempotencyKey).toBe(event?.id ?? "");
    expect(event?.title).toContain(channel.name);

    const failingTag = crypto.randomUUID();
    const failing = yield* createChannel({
      url: yield* sinkUrl(failingTag, "&fail=503"),
    });
    const failed = yield* send("POST", `/api/channels/${failing.id}/test`);
    expect(failed.status).toBe(200);
    expect(yield* bodyOf(ChannelTestResult)(failed)).toEqual({
      delivered: false,
      error: "HTTP 503: failed",
      status: 503,
    });

    expect((yield* send("POST", "/api/channels/missing/test")).status).toBe(
      404
    );
    yield* send("DELETE", `/api/channels/${channel.id}`);
    yield* send("DELETE", `/api/channels/${failing.id}`);
  }),
  { timeout: 60_000 }
);

/** A monitor on a fresh flip target, alerting `channels`, that is up. */
const upMonitor = Effect.fn("Test.upMonitor")(function* upMonitor(
  channels: readonly string[] | "all"
) {
  const flip = `flip-${crypto.randomUUID()}`;
  const monitor = yield* create({
    channels,
    intervalSeconds: 5,
    url: yield* devUrl(`/target/flip/${flip}`),
  });
  yield* waitFor("up", detail(monitor.id), (d) => statusOf(d) === "up");
  return { flip, monitor };
});

test(
  "sends the down alert and then the recovery alert",
  Effect.gen(function* downUpAlertTest() {
    const tag = crypto.randomUUID();
    const channel = yield* createChannel({ url: yield* sinkUrl(tag) });
    const { flip, monitor } = yield* upMonitor([channel.id]);

    yield* setFlip(flip, false);
    const [down] = yield* waitFor(
      "down alert",
      received(tag),
      (events) => events.length === 1
    );
    const [incident] = (yield* detail(monitor.id)).incidents;
    const incidentId = incident?.id ?? "";
    expect(down?.event).toBe("down");
    expect(down?.recovered).toBe(false);
    expect(down?.id).toBe(`${incidentId}:down:${channel.id}`);
    expect(down?.idempotencyKey).toBe(down?.id ?? "");
    expect(down?.title).toBe("integration is down");

    yield* setFlip(flip, true);
    const [, up] = yield* waitFor(
      "recovery alert",
      received(tag),
      (list) => list.length === 2
    );
    expect(up?.event).toBe("up");
    expect(up?.id).toBe(`${incidentId}:up:${channel.id}`);
    expect(up?.title).toStartWith("integration is up again after");

    const after = yield* detail(monitor.id);
    expect(
      after.alerts.outbox.map((row) => [row.event, row.state, row.attempts])
    ).toEqual([
      ["up", "delivered", 1],
      ["down", "delivered", 1],
    ]);
    expect(after.alerts.notifications.every((n) => n.resolved)).toBe(true);
    expect(after.alerts.recipients).toEqual([
      { channelId: channel.id, incidentId },
    ]);
    expect(after.status.alarmAt).toBeNumber();

    yield* send("DELETE", `/api/monitors/${monitor.id}`);
    yield* send("DELETE", `/api/channels/${channel.id}`);
  }),
  { timeout: 90_000 }
);

test(
  "retries an alert after the sink answers 500; a retry after recovery says so",
  Effect.gen(function* retryAlertTest() {
    const tag = crypto.randomUUID();
    const channel = yield* createChannel({
      url: yield* sinkUrl(tag, "&fail=500&failTimes=1"),
    });
    const { flip, monitor } = yield* upMonitor([channel.id]);

    yield* setFlip(flip, false);
    const [first] = yield* waitFor(
      "failed attempt",
      received(tag),
      (events) => events.length === 1
    );
    expect(first?.respondedWith).toBe(500);
    const pending = yield* waitFor(
      "attempt recorded",
      detail(monitor.id),
      (d) => d.alerts.outbox[0]?.attempts === 1
    );
    const [row] = pending.alerts.outbox;
    expect(row?.state).toBe("pending");
    expect(row?.lastError).toBe("HTTP 500: failed");
    expect((row?.nextAttemptAt ?? 0) - (row?.updatedAt ?? 0)).toBe(30_000);
    expect(pending.status.alarmAt).toBeLessThanOrEqual(row?.nextAttemptAt ?? 0);

    // Recover before the retry: the retried down alert reports the
    // recovery and the separate recovery alert is skipped.
    yield* setFlip(flip, true);
    yield* waitFor(
      "recovered",
      detail(monitor.id),
      (d) => statusOf(d) === "up"
    );
    const [, retried] = yield* waitFor(
      "retried alert",
      received(tag),
      (list) => list.length === 2,
      60_000
    );
    expect(retried?.respondedWith).toBe(200);
    expect(retried?.id).toBe(first?.id ?? "");
    expect(retried?.idempotencyKey).toBe(first?.id ?? "");
    expect(retried?.recovered).toBe(true);
    expect(retried?.title).toContain("was down for");

    const after = yield* waitFor("up skipped", detail(monitor.id), (d) =>
      d.alerts.outbox.some((r) => r.event === "up" && r.state === "skipped")
    );
    expect(
      after.alerts.outbox.map((r) => [r.event, r.state, r.attempts, r.combined])
    ).toEqual([
      ["up", "skipped", 0, false],
      ["down", "delivered", 2, true],
    ]);
    yield* Effect.sleep("3 seconds");
    expect(yield* received(tag)).toHaveLength(2);

    yield* send("DELETE", `/api/monitors/${monitor.id}`);
    yield* send("DELETE", `/api/channels/${channel.id}`);
  }),
  { timeout: 120_000 }
);

test(
  "a permanently failed down alert means no recovery alert on that channel",
  Effect.gen(function* permanentFailureTest() {
    const tag = crypto.randomUUID();
    const channel = yield* createChannel({
      url: yield* sinkUrl(tag, "&fail=404"),
    });
    const { flip, monitor } = yield* upMonitor([channel.id]);
    yield* setFlip(flip, false);
    yield* waitFor(
      "down failed",
      detail(monitor.id),
      (d) => d.alerts.outbox[0]?.state === "failed"
    );
    yield* setFlip(flip, true);
    const after = yield* waitFor("up skipped", detail(monitor.id), (d) =>
      d.alerts.outbox.some((r) => r.event === "up" && r.state === "skipped")
    );
    expect(after.alerts.outbox.map((r) => [r.event, r.state])).toEqual([
      ["up", "skipped"],
      ["down", "failed"],
    ]);
    expect(yield* received(tag)).toHaveLength(1);
    yield* send("DELETE", `/api/monitors/${monitor.id}`);
    yield* send("DELETE", `/api/channels/${channel.id}`);
  }),
  { timeout: 90_000 }
);

test(
  "a channel added mid-incident gets neither the down nor the up alert",
  Effect.gen(function* channelAddedMidIncidentTest() {
    const tagA = crypto.randomUUID();
    const tagB = crypto.randomUUID();
    const channelA = yield* createChannel({ url: yield* sinkUrl(tagA) });
    const { flip, monitor } = yield* upMonitor("all");

    yield* setFlip(flip, false);
    yield* waitFor(
      "down alert",
      received(tagA),
      (events) => events.length === 1
    );
    const channelB = yield* createChannel({ url: yield* sinkUrl(tagB) });

    yield* setFlip(flip, true);
    const events = yield* waitFor(
      "recovery alert",
      received(tagA),
      (list) => list.length === 2
    );
    expect(events.map((event) => event.event)).toEqual(["down", "up"]);
    yield* Effect.sleep("3 seconds");
    expect(yield* received(tagB)).toHaveLength(0);
    const after = yield* detail(monitor.id);
    expect(after.alerts.recipients.map((r) => r.channelId)).toEqual([
      channelA.id,
    ]);
    expect(after.alerts.outbox.some((r) => r.channelId === channelB.id)).toBe(
      false
    );

    yield* send("DELETE", `/api/monitors/${monitor.id}`);
    yield* send("DELETE", `/api/channels/${channelA.id}`);
    yield* send("DELETE", `/api/channels/${channelB.id}`);
  }),
  { timeout: 90_000 }
);

test(
  "disabling a down monitor closes the incident without a recovery alert",
  Effect.gen(function* disableWithoutAlertTest() {
    const tag = crypto.randomUUID();
    const channel = yield* createChannel({ url: yield* sinkUrl(tag) });
    const { flip, monitor } = yield* upMonitor([channel.id]);
    yield* setFlip(flip, false);
    yield* waitFor(
      "down alert",
      received(tag),
      (events) => events.length === 1
    );

    const disabled = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    yield* setFlip(flip, true);
    yield* Effect.sleep("8 seconds");

    const after = yield* detail(monitor.id);
    expect(after.incidents[0]?.resolution).toBe("disabled");
    expect(after.alerts.notifications.map((n) => n.event)).toEqual(["down"]);
    expect(after.alerts.outbox.map((r) => [r.event, r.state])).toEqual([
      ["down", "delivered"],
    ]);
    // No alert work left: only the daily maintenance is armed.
    expect(after.status.alarmAt).toBe(
      after.status.snapshot?.state.nextMaintenanceAt ?? Number.NaN
    );
    expect(yield* received(tag)).toHaveLength(1);

    yield* send("DELETE", `/api/monitors/${monitor.id}`);
    yield* send("DELETE", `/api/channels/${channel.id}`);
  }),
  { timeout: 90_000 }
);
