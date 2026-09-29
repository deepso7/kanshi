import { setTimeout as sleep } from "node:timers/promises";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  discardBody,
  drainMaxBytes,
  drainMaxMs,
  guardBody,
  guardedBodyOf,
  limitBody,
  signInMaxBytes,
} from "../../src/http/body-limit.ts";

const url = "https://kanshi.example.com/api/session";

/** A body sent in chunks, without a `content-length` (chunked). */
const chunked = (size: number, chunkSize = 512) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < size; sent += chunkSize) {
        controller.enqueue(new Uint8Array(Math.min(chunkSize, size - sent)));
      }
      controller.close();
    },
  });

/**
 * A body that sends `sent` bytes, then never another nor its end (a slow
 * or stalled upload); `cancelled` says whether the reader gave up on it.
 */
const stalled = (sent: number) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      if (sent > 0) {
        controller.enqueue(new Uint8Array(sent));
      }
    },
  });
  return { body, cancelled: () => cancelled };
};

/** Let the body's promises run (real time; the Effect clock is a test one). */
const settle = Effect.promise(() => sleep(20));

const post = (init: RequestInit) =>
  HttpServerRequest.fromWeb(new Request(url, { method: "POST", ...init }));

/** A POST and the web `Request` under it, to see whether its body was read. */
const postWeb = (init: RequestInit) => {
  const web = new Request(url, { method: "POST", ...init });
  return { request: HttpServerRequest.fromWeb(web), web };
};

describe(guardedBodyOf, () => {
  it("guards the sign-in only, with or without a trailing slash", () => {
    assert.strictEqual(
      guardedBodyOf("POST", "/api/session")?.maxBytes,
      signInMaxBytes
    );
    assert.isNotNull(guardedBodyOf("POST", "/api/session/"));
    assert.isNull(guardedBodyOf("DELETE", "/api/session"));
    assert.isNull(guardedBodyOf("GET", "/api/session"));
    assert.isNull(guardedBodyOf("POST", "/api/monitors"));
  });
});

describe(limitBody, () => {
  it.effect("refuses a declared length over the limit, body drained", () =>
    Effect.gen(function* declaredTest() {
      const within = post({
        body: "x".repeat(100),
        headers: { "content-length": "100" },
      });
      assert.strictEqual(yield* limitBody(within, 100), within);
      const over = postWeb({
        body: "x".repeat(100),
        headers: { "content-length": "100" },
      });
      assert.isNull(yield* limitBody(over.request, 99));
      assert.isTrue(over.web.bodyUsed);
    })
  );

  it.effect("refuses a chunked body over the limit, read to its end", () =>
    Effect.gen(function* chunkedTest() {
      const { request, web } = postWeb({
        body: chunked(64 * 1024),
        duplex: "half",
      });
      assert.isUndefined(request.headers["content-length"]);
      assert.isNull(yield* limitBody(request, signInMaxBytes));
      assert.isTrue(web.bodyUsed);
    })
  );

  it.effect("refuses a chunked body past the drain limit", () =>
    Effect.gen(function* hugeTest() {
      const request = post({
        body: chunked(drainMaxBytes + 1, 64 * 1024),
        duplex: "half",
      });
      assert.isNull(yield* limitBody(request, signInMaxBytes));
    })
  );

  it.effect(
    "refuses a chunked body over the limit that never ends, in time",
    () =>
      Effect.gen(function* stalledTest() {
        const upload = stalled(signInMaxBytes + 1);
        const fiber = yield* limitBody(
          post({ body: upload.body, duplex: "half" }),
          signInMaxBytes
        ).pipe(Effect.forkChild);
        yield* settle;
        yield* TestClock.adjust(drainMaxMs - 1);
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust(1);
        assert.isNull(yield* Fiber.join(fiber));
        assert.isTrue(upload.cancelled());
      })
  );

  it.effect("waits for a slow chunked body while it is within the limit", () =>
    Effect.gen(function* slowTest() {
      const text = JSON.stringify({ token: "slow" });
      const sent = Promise.withResolvers<undefined>();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await sent.promise;
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
      const fiber = yield* limitBody(
        post({ body, duplex: "half" }),
        signInMaxBytes
      ).pipe(Effect.forkChild);
      yield* settle;
      // Not refused (yet), so no drain deadline runs.
      yield* TestClock.adjust(10 * drainMaxMs);
      assert.isUndefined(fiber.pollUnsafe());
      sent.resolve();
      const limited = yield* Fiber.join(fiber);
      assert.strictEqual(yield* limited?.text ?? Effect.succeed(""), text);
    })
  );

  it.effect("buffers a body of one-byte chunks up to the limit", () =>
    Effect.gen(function* byteChunksTest() {
      const bytes = new Uint8Array(signInMaxBytes).map((_, index) => index);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) {
            controller.enqueue(Uint8Array.of(byte));
          }
          controller.close();
        },
      });
      const limited = yield* limitBody(
        post({ body, duplex: "half" }),
        signInMaxBytes
      );
      const read = yield* (
        limited?.arrayBuffer ?? Effect.succeed(new ArrayBuffer(0))
      );
      assert.deepStrictEqual(new Uint8Array(read), bytes);
    })
  );

  it.effect("buffers a chunked body within the limit for the API", () =>
    Effect.gen(function* withinTest() {
      const text = JSON.stringify({ token: "t".repeat(1000) });
      const request = post({
        body: new Blob([text]).stream(),
        duplex: "half",
        headers: { "content-type": "application/json", origin: url },
      });
      const limited = yield* limitBody(request, signInMaxBytes);
      assert.isNotNull(limited);
      assert.strictEqual(yield* limited?.text ?? Effect.succeed(""), text);
      assert.strictEqual(limited?.headers.origin, url);
      assert.strictEqual(limited?.method, "POST");
      assert.strictEqual(limited?.url, "/api/session");
    })
  );
});

describe(discardBody, () => {
  it.effect("reads a body within the drain limit", () =>
    Effect.gen(function* drainTest() {
      const { request, web } = postWeb({
        body: chunked(8 * 1024),
        duplex: "half",
      });
      yield* discardBody(request);
      assert.isTrue(web.bodyUsed);
    })
  );

  it.effect("gives up on a body that never ends after the drain time", () =>
    Effect.gen(function* stalledTest() {
      const upload = stalled(100);
      const fiber = yield* discardBody(
        post({ body: upload.body, duplex: "half" })
      ).pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust(drainMaxMs - 1);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      assert.isTrue(upload.cancelled());
    })
  );

  it.effect("leaves a body declared past the drain limit unread", () =>
    Effect.gen(function* unreadTest() {
      const { request, web } = postWeb({
        body: "x",
        headers: { "content-length": String(drainMaxBytes + 1) },
      });
      yield* discardBody(request);
      assert.isFalse(web.bodyUsed);
    })
  );
});

describe(guardBody, () => {
  it.effect("refuses another origin's never-ending upload in time", () =>
    Effect.gen(function* forbiddenTest() {
      const upload = stalled(0);
      const request = post({
        body: upload.body,
        duplex: "half",
        headers: { origin: "https://evil.example.com" },
      });
      const fiber = yield* guardBody(
        request,
        "/api/session",
        Effect.succeed(HttpServerResponse.empty({ status: 204 }))
      ).pipe(Effect.forkChild);
      yield* settle;
      yield* TestClock.adjust(drainMaxMs);
      const response = yield* Fiber.join(fiber);
      assert.strictEqual(response.status, 403);
      assert.isTrue(upload.cancelled());
    })
  );
});
