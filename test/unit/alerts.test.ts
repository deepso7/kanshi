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
/** The body a failing health endpoint answers with. */
const aspenBody =
  '{"_tag":"ServiceUnavailable","details":{"checkedAt":"2026-09-30T10:00:00.000Z","checks":{"openrouter":"low","x":"ok","supadata":"ok"},"ok":false},"message":"One or more required dependencies are unhealthy"}';
const incident = {
  cause: "expected 2xx, got 500",
  id: "inc1",
  lastHttpStatus: 500,
  latencyMs: 412,
  resolvedAt: null,
  responseExcerpt: { text: aspenBody, truncated: false },
  startedAt: t0,
};
const downAlert = {
  idempotencyKey: idempotencyKey("inc1", "down", "c1"),
  incident,
  monitor,
  sentAt: t0 + 1000,
};
const down = AlertMessage.Down(downAlert);
/** A down alert whose excerpt is `text`. */
const downWith = (text: string, truncated = false) =>
  AlertMessage.Down({
    ...downAlert,
    incident: { ...incident, responseExcerpt: { text, truncated } },
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
const testAlert = AlertMessage.Test({
  channelName: "Ops",
  idempotencyKey: "test:c1:x",
  sentAt: t0,
});

const DiscordBody = Schema.fromJsonString(
  Schema.Struct({
    allowed_mentions: Schema.Struct({ parse: Schema.Array(Schema.String) }),
    content: Schema.optionalKey(Schema.String),
    embeds: Schema.Array(
      Schema.Struct({
        color: Schema.Number,
        description: Schema.optionalKey(Schema.String),
        fields: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              inline: Schema.Boolean,
              name: Schema.String,
              value: Schema.String,
            })
          )
        ),
        timestamp: Schema.String,
        title: Schema.String,
        url: Schema.optionalKey(Schema.String),
      })
    ),
  })
);
const discordOf = (message: AlertMessage) =>
  Schema.decodeUnknownSync(DiscordBody)(
    alertRequest("discord", "https://discord.com/api/webhooks/1/x", message)
      .body
  );
const embedOf = (message: AlertMessage) => {
  const [embed] = discordOf(message).embeds;
  assert.isDefined(embed);
  return embed;
};

const SlackBody = Schema.fromJsonString(
  Schema.Struct({ blocks: Schema.Array(Schema.Json), text: Schema.String })
);
const slackOf = (message: AlertMessage) =>
  Schema.decodeUnknownSync(SlackBody)(
    alertRequest("slack", "https://hooks.slack.com/x", message).body
  );

const WebhookBody = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    id: Schema.String,
    incident: Schema.NullOr(
      Schema.Struct({ durationMs: Schema.Number, latencyMs: Schema.Json })
    ),
    monitor: Schema.Json,
    recovered: Schema.Boolean,
    responseExcerpt: Schema.NullOr(Schema.String),
    responseTruncated: Schema.Boolean,
    title: Schema.String,
  })
);
const decodeWebhook = Schema.decodeUnknownSync(WebhookBody);

const aspenPretty = JSON.stringify(JSON.parse(aspenBody), null, 2);

/** Occurrences of ``` in `text`. */
const fences = (text: string) => text.split("```").length - 1;

/** A signed URL of `length` characters, with `&` to escape. */
const longUrl = (length: number) => {
  const head = "https://example.com/reports/";
  const query = "?X-Signature=a&b=c".padEnd(length - head.length, "x&y");
  return `${head}${query}`;
};
/** A down alert past every limit: long URL, name, cause and excerpt. */
const oversized = (url: string) =>
  AlertMessage.Down({
    ...downAlert,
    incident: {
      ...incident,
      cause: `expected 2xx, got 500: ${"<é&>".repeat(1500)}`,
      responseExcerpt: {
        text: JSON.stringify({ items: "x".repeat(5000) }),
        truncated: true,
      },
    },
    monitor: { ...monitor, name: "N".repeat(400), url },
  });

/** The length of `text` in UTF-8 bytes. */
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

const SlackBlocks = Schema.Array(
  Schema.Struct({
    fields: Schema.optionalKey(
      Schema.Array(Schema.Struct({ text: Schema.String }))
    ),
    text: Schema.optionalKey(Schema.Struct({ text: Schema.String })),
    type: Schema.String,
  })
);

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
    assert.deepStrictEqual(alertText(recovered), {
      body: "Down for 12m\nhttps://example.com/",
      title: "Site recovered",
    });
    assert.strictEqual(
      alertText(downRecovered).title,
      "Site was down for 12m, recovered"
    );
    assert.strictEqual(
      alertText(testAlert).title,
      'Test alert for channel "Ops"'
    );
  });

  it("never names Kanshi in an alert", () => {
    const episode = {
      id: "w1",
      intervalSeconds: 300,
      lastCheckedAt: t0,
      resolvedAt: null,
      startedAt: t0 + minute,
    };
    const episodeAlert = {
      episode,
      idempotencyKey: "w1:down:c1",
      monitor,
      sentAt: t0 + 16 * minute,
    };
    const messages = [
      down,
      recovered,
      downRecovered,
      testAlert,
      AlertMessage.NotChecked(episodeAlert),
      AlertMessage.NotCheckedResolved(episodeAlert),
      AlertMessage.CheckedAgain(episodeAlert),
    ];
    for (const message of messages) {
      for (const kind of ["slack", "discord", "ntfy", "webhook"] as const) {
        const request = alertRequest(kind, "https://example.com/x", message);
        assert.notInclude(
          `${request.url}${request.body}`,
          "Kanshi",
          `${alertText(message).title} to ${kind}`
        );
      }
    }
  });
});

describe("Discord payloads", () => {
  it("sends a down alert as an embed with @everyone", () => {
    const body = discordOf(down);
    assert.strictEqual(body.content, "@everyone");
    assert.deepStrictEqual(body.allowed_mentions, { parse: ["everyone"] });
    assert.deepStrictEqual(body.embeds, [
      {
        color: 0xed_42_45,
        description: `\`\`\`json\n${aspenPretty}\n\`\`\``,
        fields: [
          { inline: false, name: "Cause", value: "expected 2xx, got 500" },
          { inline: true, name: "HTTP status", value: "500" },
          { inline: true, name: "Latency", value: "412 ms" },
        ],
        timestamp: new Date(t0).toISOString(),
        title: "🔴 Site is down",
        url: "https://example.com/",
      },
    ]);
  });

  it("mentions no one on recovery or test alerts", () => {
    for (const message of [recovered, downRecovered, testAlert]) {
      const body = discordOf(message);
      assert.isUndefined(body.content, alertText(message).title);
      assert.deepStrictEqual(body.allowed_mentions, { parse: [] });
    }
    const up = embedOf(recovered);
    assert.strictEqual(up.title, "🟢 Site recovered");
    assert.strictEqual(up.color, 0x57_f2_87);
    assert.strictEqual(up.url, "https://example.com/");
    assert.isUndefined(up.description);
    assert.deepStrictEqual(up.fields?.[0], {
      inline: true,
      name: "Down for",
      value: "12m",
    });
    assert.strictEqual(up.timestamp, new Date(t0 + 12 * minute).toISOString());

    // The combined alert still shows what the outage looked like.
    const combined = embedOf(downRecovered);
    assert.strictEqual(combined.title, "🟢 Site was down for 12m, recovered");
    assert.strictEqual(
      combined.description,
      `\`\`\`json\n${aspenPretty}\n\`\`\``
    );
    assert.deepStrictEqual(
      combined.fields?.map((field) => field.name),
      ["Cause", "HTTP status", "Latency", "Down for"]
    );

    const test = embedOf(testAlert);
    assert.strictEqual(test.title, '🧪 Test alert for channel "Ops"');
    assert.strictEqual(
      test.description,
      "If you can read this, alerts reach this channel."
    );
    assert.isUndefined(test.url);
  });

  it("puts a non-JSON excerpt in a plain code block", () => {
    assert.strictEqual(
      embedOf(downWith("Service Unavailable")).description,
      "```\nService Unavailable\n```"
    );
    // A JSON scalar is not worth highlighting.
    assert.strictEqual(embedOf(downWith("42")).description, "```\n42\n```");
    // A down alert without an excerpt has no description.
    const bare = AlertMessage.Down({
      ...downAlert,
      incident: { ...incident, responseExcerpt: null },
    });
    assert.isUndefined(embedOf(bare).description);
  });

  it("marks an excerpt the probe cut, and cuts one past Discord's limits", () => {
    assert.strictEqual(
      embedOf(downWith('{"partial": tru', true)).description,
      '```\n{"partial": tru\n```\n…(truncated)'
    );
    // Pretty-printing can outgrow the 4096-character description.
    const wide = JSON.stringify(
      Array.from({ length: 400 }, (_, index) => ({ index }))
    );
    const { description = "", fields = [], title } = embedOf(downWith(wide));
    assert.isAtMost(description.length, 4096);
    assert.isTrue(description.startsWith("```json\n[\n  {"));
    assert.isTrue(description.endsWith("\n```\n…(truncated)"));
    const total =
      title.length +
      description.length +
      fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.isAtMost(total, 6000);
  });

  it("keeps every part within Discord's limits for a long URL", () => {
    const url = longUrl(5000);
    const embed = embedOf(oversized(url));
    const fields = embed.fields ?? [];
    const description = embed.description ?? "";
    assert.isAtMost(embed.title.length, 256);
    // Too long to link: shown, cut, as a field.
    assert.isUndefined(embed.url);
    const urlField = fields.find((field) => field.name === "URL");
    assert.isDefined(urlField);
    assert.isTrue(urlField?.value.startsWith("https://example.com/reports/"));
    assert.isTrue(urlField?.value.endsWith("…"));
    for (const field of fields) {
      assert.isAtMost(field.name.length, 256);
      assert.isAtMost(field.value.length, 1024);
    }
    assert.isAtMost(description.length, 4096);
    assert.isTrue(description.endsWith("…(truncated)"));
    const total =
      embed.title.length +
      description.length +
      fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.isAtMost(total, 6000);

    // A URL within 2,048 characters still links the title.
    const linked = embedOf(oversized(longUrl(2048)));
    assert.strictEqual(linked.url, longUrl(2048));
    assert.isUndefined(linked.fields?.find((field) => field.name === "URL"));
  });

  it("keeps backticks in the body from closing the block", () => {
    const { description = "" } = embedOf(
      downWith("oops ``` @everyone ```` done")
    );
    assert.strictEqual(fences(description), 2);
    assert.isTrue(description.startsWith("```\noops `\u200B`\u200B` "));
  });
});

describe("Slack payloads", () => {
  it("sends Block Kit with <!channel> on down alerts", () => {
    const body = slackOf(down);
    assert.strictEqual(body.text, "<!channel> 🔴 Site is down");
    assert.deepStrictEqual(body.blocks, [
      {
        text: { emoji: true, text: "🔴 Site is down", type: "plain_text" },
        type: "header",
      },
      {
        text: {
          text: "<!channel> <https://example.com/|https://example.com/>",
          type: "mrkdwn",
        },
        type: "section",
      },
      {
        fields: [
          { text: "*Cause*\nexpected 2xx, got 500", type: "mrkdwn" },
          { text: "*HTTP status*\n500", type: "mrkdwn" },
          { text: "*Latency*\n412 ms", type: "mrkdwn" },
        ],
        type: "section",
      },
      {
        text: { text: `\`\`\`\n${aspenPretty}\n\`\`\``, type: "mrkdwn" },
        type: "section",
      },
      {
        elements: [
          {
            text: `<!date^${t0 / 1000}^{date_short_pretty} at {time}|${new Date(t0).toISOString()}>`,
            type: "mrkdwn",
          },
        ],
        type: "context",
      },
    ]);
  });

  it("keeps every text within Slack's limits for a long URL", () => {
    for (const message of [
      oversized(longUrl(5000)),
      AlertMessage.Recovered({
        ...recoveredAlert,
        monitor: { ...monitor, url: longUrl(5000) },
      }),
    ]) {
      const body = slackOf(message);
      const blocks = Schema.decodeUnknownSync(SlackBlocks)(body.blocks);
      for (const block of blocks) {
        const text = block.text?.text ?? "";
        assert.isAtMost(
          text.length,
          block.type === "header" ? 150 : 3000,
          block.type
        );
        for (const field of block.fields ?? []) {
          assert.isAtMost(field.text.length, 2000);
          // Never cut through an escape.
          assert.notMatch(field.text, /&[a-z]*…$/u);
        }
      }
      // Too long to link: the URL is shown, cut, as plain text.
      const lead = blocks[1]?.text?.text ?? "";
      assert.notInclude(lead, "<https://");
      assert.include(
        lead,
        "https://example.com/reports/?X-Signature=a&amp;b=c"
      );
      assert.isTrue(lead.endsWith("…"));
    }

    // A URL that fits keeps its link, with a shortened label.
    const url = longUrl(2500);
    const lead =
      Schema.decodeUnknownSync(SlackBlocks)(slackOf(oversized(url)).blocks)[1]
        ?.text?.text ?? "";
    assert.isAtMost(lead.length, 3000);
    assert.isTrue(lead.startsWith(`<!channel> <${url}|https://example.com/`));
    assert.isTrue(lead.endsWith("…>"));
  });

  it("escapes the excerpt and mentions no one on recovery", () => {
    const html = JSON.stringify(slackOf(downWith("<b>a & b</b> ```")).blocks);
    assert.include(html, "&lt;b&gt;a &amp; b&lt;/b&gt; `\u200B`\u200B`");
    const up = slackOf(recovered);
    assert.strictEqual(up.text, "🟢 Site recovered");
    assert.notInclude(JSON.stringify(up.blocks), "<!channel>");
    assert.notInclude(JSON.stringify(slackOf(testAlert)), "<!channel>");
  });
});

describe("ntfy and webhook payloads", () => {
  it("gives generic webhooks an Idempotency-Key equal to the body id", () => {
    const request = alertRequest("webhook", "https://example.com/hook", down);
    assert.strictEqual(request.headers["idempotency-key"], "inc1:down:c1");
    const body = decodeWebhook(request.body);
    assert.strictEqual(body.id, "inc1:down:c1");
    assert.strictEqual(body.event, "down");
    assert.strictEqual(body.recovered, false);
    assert.strictEqual(body.title, "Site is down");
    assert.deepStrictEqual(body.monitor, monitor);
    assert.strictEqual(body.responseExcerpt, aspenBody);
    assert.isFalse(body.responseTruncated);
    assert.strictEqual(body.incident?.latencyMs, 412);
    // The excerpt is top-level only.
    const raw = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ incident: Schema.Record(Schema.String, Schema.Json) })
      )
    )(request.body);
    assert.notProperty(raw.incident, "responseExcerpt");
    assert.isTrue(
      decodeWebhook(
        alertRequest("webhook", "https://example.com/hook", downWith("x", true))
          .body
      ).responseTruncated
    );

    const combined = decodeWebhook(
      alertRequest("webhook", "https://example.com/hook", downRecovered).body
    );
    assert.strictEqual(combined.event, "down");
    assert.strictEqual(combined.recovered, true);
    assert.strictEqual(combined.incident?.durationMs, 12 * minute);
    assert.strictEqual(combined.responseExcerpt, aspenBody);
    const up = decodeWebhook(
      alertRequest("webhook", "https://example.com/hook", recovered).body
    );
    assert.strictEqual(up.event, "up");
    assert.strictEqual(up.id, "inc1:up:c1");
    assert.isNull(up.responseExcerpt);
    const test = decodeWebhook(
      alertRequest("webhook", "https://example.com/hook", testAlert).body
    );
    assert.strictEqual(test.event, "test");
    assert.strictEqual(test.id, "test:c1:x");
    assert.isNull(test.responseExcerpt);
  });

  it("posts ntfy messages as text with title, priority and tags in the query", () => {
    const request = alertRequest("ntfy", "https://ntfy.sh/topic?auth=tk", down);
    const url = new URL(request.url);
    assert.strictEqual(url.pathname, "/topic");
    assert.strictEqual(url.searchParams.get("auth"), "tk");
    assert.strictEqual(url.searchParams.get("title"), "Site is down");
    assert.strictEqual(url.searchParams.get("priority"), "high");
    assert.strictEqual(url.searchParams.get("tags"), "rotating_light");
    assert.strictEqual(url.searchParams.get("click"), "https://example.com/");
    assert.strictEqual(request.body, `expected 2xx, got 500\n\n${aspenPretty}`);
    assert.strictEqual(
      alertRequest("ntfy", "https://ntfy.sh/t", downWith("down", true)).body,
      "expected 2xx, got 500\n\ndown\n…(truncated)"
    );

    // An oversized cause and excerpt fit 4,000 bytes, still marked.
    const big = alertRequest(
      "ntfy",
      "https://ntfy.sh/t",
      oversized(longUrl(5000))
    );
    assert.isAtMost(bytes(big.body), 4000);
    assert.isTrue(big.body.endsWith("\n…(truncated)"));
    assert.isTrue(big.body.startsWith("expected 2xx, got 500: <é&>"));
    assert.notInclude(big.body, "\uFFFD");
    // A cause that fits is kept whole; the excerpt gives way.
    const cause = `cause ${"é".repeat(1500)}`;
    const shrunk = alertRequest(
      "ntfy",
      "https://ntfy.sh/t",
      AlertMessage.Down({
        ...downAlert,
        incident: {
          ...incident,
          cause,
          responseExcerpt: { text: "é".repeat(2000), truncated: false },
        },
      })
    ).body;
    assert.isAtMost(bytes(shrunk), 4000);
    assert.isTrue(shrunk.startsWith(`${cause}\n\n`));
    assert.isTrue(shrunk.endsWith("é\n…(truncated)"));
    // A long cause alone ends in an ellipsis.
    const alone = alertRequest(
      "ntfy",
      "https://ntfy.sh/t",
      AlertMessage.Down({
        ...downAlert,
        incident: {
          ...incident,
          cause: "é".repeat(3000),
          responseExcerpt: null,
        },
      })
    ).body;
    assert.isAtMost(bytes(alone), 4000);
    assert.isTrue(alone.endsWith("é…"));

    const up = alertRequest("ntfy", "https://ntfy.sh/t", recovered);
    const upUrl = new URL(up.url);
    assert.strictEqual(upUrl.searchParams.get("title"), "Site recovered");
    assert.strictEqual(upUrl.searchParams.get("priority"), "default");
    assert.strictEqual(upUrl.searchParams.get("tags"), "white_check_mark");
    assert.strictEqual(up.body, "Down for 12m");
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
