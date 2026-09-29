import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  backoffMs,
  classifyStatus,
  deliver,
  deliveryTimeoutMs,
  DeliveryResult,
  errorBodyBytes,
  maxAttempts,
} from "../../src/alerts/delivery.ts";
import {
  AlertMessage,
  alertRequest,
  alertText,
  formatDuration,
  idempotencyKey,
} from "../../src/alerts/message.ts";
import {
  answering,
  endlessBody,
  hanging,
  rejecting,
  testHttpClient,
} from "./http-client.ts";

const minute = 60_000;
const t0 = 1_700_000_000_000;

const monitor = { id: "m1", name: "Site", url: "https://example.com/" };
const incident = {
  cause: "expected 2xx, got 500",
  id: "inc1",
  lastHttpStatus: 500,
  resolvedAt: null,
  startedAt: t0,
};
const down = AlertMessage.Down({
  idempotencyKey: idempotencyKey("inc1", "down", "c1"),
  incident,
  monitor,
  sentAt: t0 + 1000,
});
const recoveredAlert = {
  idempotencyKey: idempotencyKey("inc1", "up", "c1"),
  incident: { ...incident, resolvedAt: t0 + 12 * minute },
  monitor,
  sentAt: t0 + 12 * minute + 500,
};
const recovered = AlertMessage.Recovered(recoveredAlert);
const downRecovered = AlertMessage.DownRecovered({
  ...recoveredAlert,
  idempotencyKey: idempotencyKey("inc1", "down", "c1"),
});

const DiscordBody = Schema.fromJsonString(
  Schema.Struct({ allowed_mentions: Schema.Json, content: Schema.String })
);
const WebhookBody = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    id: Schema.String,
    incident: Schema.NullOr(Schema.Struct({ durationMs: Schema.Number })),
    monitor: Schema.Json,
    recovered: Schema.Boolean,
  })
);
const decodeWebhook = Schema.decodeUnknownSync(WebhookBody);

describe("retry classification and backoff", () => {
  it("treats 2xx as delivered and 4xx other than 408/425/429 as permanent", () => {
    assert.strictEqual(classifyStatus(200), "delivered");
    assert.strictEqual(classifyStatus(204), "delivered");
    for (const status of [400, 401, 403, 404, 410, 413, 422]) {
      assert.strictEqual(classifyStatus(status), "permanent", `${status}`);
    }
    for (const status of [408, 425, 429, 500, 502, 503, 504, 302, 101]) {
      assert.strictEqual(classifyStatus(status), "retry", `${status}`);
    }
  });

  it("backs off exponentially from 30s to a 30m cap over 8 attempts", () => {
    const delays = Array.from({ length: maxAttempts - 1 }, (_, index) =>
      backoffMs(index + 1)
    );
    assert.deepStrictEqual(delays, [
      30_000,
      minute,
      2 * minute,
      4 * minute,
      8 * minute,
      16 * minute,
      30 * minute,
    ]);
    assert.strictEqual(backoffMs(20), 30 * minute);
    assert.strictEqual(maxAttempts, 8);
  });
});

describe("message formatting", () => {
  it("formats durations", () => {
    assert.strictEqual(formatDuration(45_000), "45s");
    assert.strictEqual(formatDuration(12 * minute + 30_000), "12m");
    assert.strictEqual(formatDuration(60 * minute), "1h");
    assert.strictEqual(formatDuration(185 * minute), "3h 5m");
    assert.strictEqual(formatDuration(52 * 60 * minute), "2d 4h");
    assert.strictEqual(formatDuration(-5), "0s");
  });

  it("says down, recovered, and down-then-recovered", () => {
    assert.deepStrictEqual(alertText(down), {
      body: "expected 2xx, got 500\nhttps://example.com/",
      title: "Site is down",
    });
    assert.strictEqual(
      alertText(recovered).title,
      "Site is up again after 12m"
    );
    assert.strictEqual(
      alertText(downRecovered).title,
      "Site was down for 12m, recovered"
    );
  });

  it("builds slack and discord payloads", () => {
    const slack = alertRequest("slack", "https://hooks.slack.com/x", down);
    assert.strictEqual(slack.url, "https://hooks.slack.com/x");
    assert.strictEqual(slack.headers["content-type"], "application/json");
    assert.deepStrictEqual(JSON.parse(slack.body), {
      text: "Kanshi: Site is down\nexpected 2xx, got 500\nhttps://example.com/",
    });
    assert.isUndefined(slack.headers["idempotency-key"]);

    const discord = alertRequest(
      "discord",
      "https://discord.com/api/webhooks/1/x",
      recovered
    );
    const body = Schema.decodeUnknownSync(DiscordBody)(discord.body);
    assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
    assert.isTrue(
      body.content.startsWith("Kanshi: Site is up again after 12m")
    );
  });

  it("gives generic webhooks an Idempotency-Key equal to the body id", () => {
    const request = alertRequest("webhook", "https://example.com/hook", down);
    assert.strictEqual(request.headers["idempotency-key"], "inc1:down:c1");
    const body = decodeWebhook(request.body);
    assert.strictEqual(body.id, "inc1:down:c1");
    assert.strictEqual(body.event, "down");
    assert.strictEqual(body.recovered, false);
    assert.deepStrictEqual(body.monitor, monitor);

    const combined = decodeWebhook(
      alertRequest("webhook", "https://example.com/hook", downRecovered).body
    );
    assert.strictEqual(combined.event, "down");
    assert.strictEqual(combined.recovered, true);
    assert.strictEqual(combined.incident?.durationMs, 12 * minute);
    const up = decodeWebhook(
      alertRequest("webhook", "https://example.com/hook", recovered).body
    );
    assert.strictEqual(up.event, "up");
    assert.strictEqual(up.id, "inc1:up:c1");
  });

  it("posts ntfy messages as text with title, priority and tags in the query", () => {
    const request = alertRequest("ntfy", "https://ntfy.sh/topic?auth=tk", down);
    const url = new URL(request.url);
    assert.strictEqual(url.pathname, "/topic");
    assert.strictEqual(url.searchParams.get("auth"), "tk");
    assert.strictEqual(url.searchParams.get("title"), "Kanshi: Site is down");
    assert.strictEqual(url.searchParams.get("priority"), "high");
    assert.strictEqual(url.searchParams.get("tags"), "rotating_light");
    assert.strictEqual(
      request.body,
      "expected 2xx, got 500\nhttps://example.com/"
    );
    assert.strictEqual(
      new URL(
        alertRequest("ntfy", "https://ntfy.sh/t", recovered).url
      ).searchParams.get("priority"),
      "default"
    );
  });

  it("formats test messages for every kind", () => {
    const test = AlertMessage.Test({
      channelName: "Ops",
      idempotencyKey: "test:c1:x",
      sentAt: t0,
    });
    assert.strictEqual(alertText(test).title, 'Test alert for channel "Ops"');
    const body = decodeWebhook(
      alertRequest("webhook", "https://example.com/hook", test).body
    );
    assert.strictEqual(body.event, "test");
    assert.strictEqual(body.id, "test:c1:x");
  });
});

describe("deliver()", () => {
  const request = alertRequest("webhook", "https://example.com/hook", down);
  it.effect("returns Delivered for 2xx", () =>
    Effect.gen(function* deliveredTest() {
      const client = answering(204, null);
      const result = yield* deliver(request).pipe(Effect.provide(client.layer));
      assert.deepStrictEqual(result, DeliveryResult.Delivered({ status: 204 }));
      const [sent] = client.sent;
      assert.strictEqual(sent?.request.method, "POST");
      assert.strictEqual(sent?.request.url, "https://example.com/hook");
      assert.strictEqual(
        sent?.request.headers["idempotency-key"],
        "inc1:down:c1"
      );
      assert.strictEqual(
        sent?.request.headers["user-agent"],
        "Kanshi uptime monitor"
      );
      assert.strictEqual(
        sent?.request.headers["content-type"],
        "application/json"
      );
      assert.strictEqual(sent?.redirect, "follow");
    })
  );

  it.effect("classifies failures", () =>
    Effect.gen(function* failuresTest() {
      assert.deepStrictEqual(
        yield* deliver(request).pipe(
          Effect.provide(answering(404, "nope").layer)
        ),
        DeliveryResult.Failed({
          error: "HTTP 404: nope",
          permanent: true,
          status: 404,
        })
      );
      for (const status of [408, 425, 429, 500, 503]) {
        const transient = yield* deliver(request).pipe(
          Effect.provide(answering(status).layer)
        );
        assert.deepStrictEqual(
          transient,
          DeliveryResult.Failed({
            error: `HTTP ${status}`,
            permanent: false,
            status,
          })
        );
      }
      const offline = yield* deliver(request).pipe(
        Effect.provide(rejecting(new Error("connection refused")).layer)
      );
      assert.deepStrictEqual(
        offline,
        DeliveryResult.Failed({
          error: "connection refused",
          permanent: false,
          status: null,
        })
      );
    })
  );

  it.effect("times out, and aborts the request", () =>
    Effect.gen(function* timeoutTest() {
      const client = hanging();
      const fiber = yield* deliver(request).pipe(
        Effect.provide(client.layer),
        Effect.forkChild
      );
      yield* TestClock.adjust(deliveryTimeoutMs - 1);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(
        yield* Fiber.join(fiber),
        DeliveryResult.Failed({
          error: `no response within ${deliveryTimeoutMs}ms`,
          permanent: false,
          status: null,
        })
      );
      assert.isTrue(client.sent[0]?.signal.aborted);
    })
  );

  it.effect("waits for a slow endpoint within the timeout", () =>
    Effect.gen(function* slowTest() {
      const client = testHttpClient(() =>
        Effect.sleep(deliveryTimeoutMs - 1).pipe(
          Effect.as(new Response(null, { status: 200 }))
        )
      );
      const fiber = yield* deliver(request).pipe(
        Effect.provide(client.layer),
        Effect.forkChild
      );
      yield* TestClock.adjust(deliveryTimeoutMs - 1);
      assert.deepStrictEqual(
        yield* Fiber.join(fiber),
        DeliveryResult.Delivered({ status: 200 })
      );
    })
  );

  it.effect(
    "reads a bounded prefix of a failed response's body, then cancels it",
    () =>
      Effect.gen(function* boundedBodyTest() {
        // An endless body: reading it whole would never return.
        const endless = endlessBody(512);
        const client = testHttpClient(() =>
          Effect.succeed(new Response(endless.body, { status: 500 }))
        );
        const result = yield* deliver(request).pipe(
          Effect.provide(client.layer)
        );
        assert.deepStrictEqual(
          result,
          DeliveryResult.Failed({
            error: `HTTP 500: ${"x".repeat(200)}`,
            permanent: false,
            status: 500,
          })
        );
        assert.isTrue(endless.seen.cancelled);
        // The stream may pull ahead a chunk or two, never much more.
        assert.isAtMost(endless.seen.pulled * 512, errorBodyBytes + 3 * 512);
      })
  );

  it.effect("does not read the body of a delivered response", () =>
    Effect.gen(function* deliveredBodyTest() {
      const endless = endlessBody(512);
      const client = testHttpClient(() =>
        Effect.succeed(new Response(endless.body, { status: 200 }))
      );
      const result = yield* deliver(request).pipe(Effect.provide(client.layer));
      assert.deepStrictEqual(result, DeliveryResult.Delivered({ status: 200 }));
      // Unread (at most the stream's own prefetch), and the request is
      // aborted, which releases the connection.
      assert.isAtMost(endless.seen.pulled, 1);
      assert.isTrue(client.sent[0]?.signal.aborted);
    })
  );
});
