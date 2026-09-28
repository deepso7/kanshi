import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  backoffMs,
  classifyStatus,
  deliver,
  errorBodyBytes,
  maxAttempts,
} from "../../src/alerts/delivery.ts";
import type { AlertMessage } from "../../src/alerts/message.ts";
import {
  alertRequest,
  alertText,
  formatDuration,
  idempotencyKey,
} from "../../src/alerts/message.ts";
import type { FetchLike } from "../../src/domain/probe.ts";

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
const down: AlertMessage = {
  _tag: "Down",
  idempotencyKey: idempotencyKey("inc1", "down", "c1"),
  incident,
  monitor,
  sentAt: t0 + 1000,
};
const recovered: AlertMessage = {
  _tag: "Recovered",
  idempotencyKey: idempotencyKey("inc1", "up", "c1"),
  incident: { ...incident, resolvedAt: t0 + 12 * minute },
  monitor,
  sentAt: t0 + 12 * minute + 500,
};
const downRecovered: AlertMessage = {
  ...recovered,
  _tag: "DownRecovered",
  idempotencyKey: idempotencyKey("inc1", "down", "c1"),
};

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
    const body = JSON.parse(discord.body) as {
      allowed_mentions: unknown;
      content: string;
    };
    assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
    assert.isTrue(
      body.content.startsWith("Kanshi: Site is up again after 12m")
    );
  });

  it("gives generic webhooks an Idempotency-Key equal to the body id", () => {
    const request = alertRequest("webhook", "https://example.com/hook", down);
    assert.strictEqual(request.headers["idempotency-key"], "inc1:down:c1");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    assert.strictEqual(body.id, "inc1:down:c1");
    assert.strictEqual(body.event, "down");
    assert.strictEqual(body.recovered, false);
    assert.deepStrictEqual(body.monitor, monitor);

    const combined = JSON.parse(
      alertRequest("webhook", "https://example.com/hook", downRecovered).body
    ) as Record<string, unknown>;
    assert.strictEqual(combined.event, "down");
    assert.strictEqual(combined.recovered, true);
    assert.strictEqual(
      (combined.incident as { durationMs: number }).durationMs,
      12 * minute
    );
    const up = JSON.parse(
      alertRequest("webhook", "https://example.com/hook", recovered).body
    ) as Record<string, unknown>;
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
    const test: AlertMessage = {
      _tag: "Test",
      channelName: "Ops",
      idempotencyKey: "test:c1:x",
      sentAt: t0,
    };
    assert.strictEqual(alertText(test).title, 'Test alert for channel "Ops"');
    const body = JSON.parse(
      alertRequest("webhook", "https://example.com/hook", test).body
    ) as Record<string, unknown>;
    assert.strictEqual(body.event, "test");
    assert.strictEqual(body.id, "test:c1:x");
  });
});

const answering =
  (status: number, text = ""): FetchLike =>
  () =>
    Promise.resolve(new Response(text, { status }));

describe("deliver", () => {
  const request = alertRequest("webhook", "https://example.com/hook", down);
  it.effect("returns Delivered for 2xx", () =>
    Effect.gen(function* deliveredTest() {
      let seen: RequestInit = {};
      const result = yield* deliver(request, (_url, init) => {
        seen = init;
        return Promise.resolve(new Response(null, { status: 204 }));
      });
      assert.deepStrictEqual(result, { _tag: "Delivered", status: 204 });
      assert.strictEqual(seen.method, "POST");
      assert.strictEqual(
        (seen.headers as Record<string, string>)["idempotency-key"],
        "inc1:down:c1"
      );
    })
  );

  it.effect("classifies failures", () =>
    Effect.gen(function* failuresTest() {
      assert.deepStrictEqual(yield* deliver(request, answering(404, "nope")), {
        _tag: "Failed",
        error: "HTTP 404: nope",
        permanent: true,
        status: 404,
      });
      const busy = yield* deliver(request, answering(429));
      assert.isTrue(busy._tag === "Failed" && !busy.permanent);
      const broken = yield* deliver(request, answering(500));
      assert.isTrue(broken._tag === "Failed" && !broken.permanent);
      const offline = yield* deliver(request, () =>
        Promise.reject(new Error("connection refused"))
      );
      assert.deepStrictEqual(offline, {
        _tag: "Failed",
        error: "connection refused",
        permanent: false,
        status: null,
      });
    })
  );

  it.effect(
    "reads a bounded prefix of a failed response's body, then cancels it",
    () =>
      Effect.gen(function* boundedBodyTest() {
        const chunk = new TextEncoder().encode("x".repeat(512));
        let pulled = 0;
        let cancelled = false;
        // An endless body: `response.text()` would never return.
        const endless = new ReadableStream<Uint8Array>({
          cancel: () => {
            cancelled = true;
          },
          pull: (controller) => {
            pulled += 1;
            controller.enqueue(chunk);
          },
        });
        const result = yield* deliver(request, () =>
          Promise.resolve(new Response(endless, { status: 500 }))
        );
        assert.deepStrictEqual(result, {
          _tag: "Failed",
          error: `HTTP 500: ${"x".repeat(200)}`,
          permanent: false,
          status: 500,
        });
        assert.isTrue(cancelled);
        // The stream may pull ahead a chunk or two, never much more.
        assert.isAtMost(pulled * chunk.byteLength, errorBodyBytes + 3 * 512);
      })
  );

  it.effect("does not read the body of a delivered response", () =>
    Effect.gen(function* deliveredBodyTest() {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled = true;
        },
        pull: (controller) => {
          controller.enqueue(new Uint8Array(512));
        },
      });
      const result = yield* deliver(request, () =>
        Promise.resolve(new Response(body, { status: 200 }))
      );
      assert.deepStrictEqual(result, { _tag: "Delivered", status: 200 });
      assert.isTrue(cancelled);
    })
  );
});
