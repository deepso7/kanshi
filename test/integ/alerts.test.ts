// Integration tests for alerts: channels, notifications and the outbox,
// driven by real alarms at 5s intervals against the `/_dev/target` fixtures
// and the `/_dev/webhook` sink. Run with `pnpm test:integ`.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";

import type { ChannelView } from "../../src/domain/channel.ts";
import { setup } from "./harness.ts";

const { create, devUrl, send, test } = setup("integ-alerts");

/** A sink URL whose events can be told apart by `tag`. */
const sinkUrl = (tag: string, query = "") =>
  devUrl(`/webhook?tag=${tag}${query}`);

const createChannel = Effect.fn("Test.createChannel")(function* createChannel(
  body: Record<string, unknown>
) {
  const reply = yield* send("POST", "/api/channels", {
    body: { kind: "webhook", name: "integration channel", ...body },
  });
  expect(reply.status).toBe(201);
  return reply.body as ChannelView;
});

test(
  "channel URLs are write-only: masked and hashed, never returned",
  Effect.gen(function* channelSecrecyTest() {
    const secret = `secret-${crypto.randomUUID()}`;
    const key = `c-${crypto.randomUUID()}`;
    const url = yield* sinkUrl(secret);
    const channel = yield* createChannel({ key, url });
    const hash = new Bun.CryptoHasher("sha256").update(url).digest("hex");
    expect(channel.urlHash).toBe(hash);
    expect(channel.maskedUrl).toStartWith("http://localhost:");
    expect(channel.maskedUrl).not.toContain(secret);

    const listed = yield* send("GET", "/api/channels");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(
      (listed.body as readonly ChannelView[]).some((c) => c.id === channel.id)
    ).toBe(true);

    // The URL is replaceable; the new one is not readable either.
    const replacement = yield* sinkUrl(`replaced-${secret}`);
    const patched = yield* send("PATCH", `/api/channels/${channel.id}`, {
      body: { name: "renamed", url: replacement },
    });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.body)).not.toContain(secret);
    const patchedView = patched.body as ChannelView;
    expect(patchedView.name).toBe("renamed");
    expect(patchedView.urlHash).not.toBe(hash);

    // Validation: https only outside loopback, unique keys, known ids.
    const insecure = yield* send("POST", "/api/channels", {
      body: { kind: "slack", name: "x", url: "http://example.com/hook" },
    });
    expect(insecure.status).toBe(400);
    const duplicate = yield* send("POST", "/api/channels", {
      body: { key, kind: "webhook", name: "x", url },
    });
    expect(duplicate.status).toBe(409);
    const unknownChannel = yield* send("POST", "/api/monitors", {
      body: {
        channels: [channel.id, "missing-channel"],
        name: "x",
        url: yield* devUrl("/target"),
      },
    });
    expect(unknownChannel.status).toBe(400);
    expect((unknownChannel.body as { message: string }).message).toContain(
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
