import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  discardBody,
  drainMaxBytes,
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
