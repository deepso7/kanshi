import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import { isLoopbackHost } from "../../src/dev/routes.ts";
import {
  matchesExpectedStatus,
  parseExpectedStatus,
} from "../../src/domain/expected-status.ts";
import { buildConfig, patchConfig } from "../../src/domain/monitor-input.ts";
import {
  classifyFetchError,
  excerptBytes,
  excerptReadMs,
  maxBodyBytes,
  probe,
} from "../../src/domain/probe.ts";
import { overallStatus } from "../../src/domain/public-status.ts";
import { checkTargetUrl } from "../../src/domain/url.ts";
import {
  answering,
  endlessBody,
  hanging,
  rejecting,
  testHttpClient,
} from "./http-client.ts";

const prod = { allowLoopback: false };
const dev = { allowLoopback: true };

describe("expected status", () => {
  it("parses codes, classes and lists into a canonical form", () => {
    assert.deepStrictEqual(parseExpectedStatus(200), Result.succeed("200"));
    assert.deepStrictEqual(parseExpectedStatus("2XX"), Result.succeed("2xx"));
    assert.deepStrictEqual(
      parseExpectedStatus(" 200, 204 ,3xx,200"),
      Result.succeed("200,204,3xx")
    );
  });

  it("rejects malformed specs", () => {
    for (const input of ["", "abc", "600", "20", "2x", "200,", 99]) {
      assert.isTrue(Result.isFailure(parseExpectedStatus(input)), `${input}`);
    }
  });

  it("matches statuses", () => {
    assert.isTrue(matchesExpectedStatus("2xx", 204));
    assert.isFalse(matchesExpectedStatus("2xx", 301));
    assert.isTrue(matchesExpectedStatus("200,3xx", 302));
    assert.isFalse(matchesExpectedStatus("200", 201));
  });
});

describe("target URL rules", () => {
  it("accepts public http(s) URLs and defaults to https", () => {
    assert.deepStrictEqual(
      checkTargetUrl("example.com/health", prod),
      Result.succeed("https://example.com/health")
    );
    assert.deepStrictEqual(
      checkTargetUrl("http://example.com", prod),
      Result.succeed("http://example.com/")
    );
    assert.deepStrictEqual(
      checkTargetUrl("https://1.1.1.1/", prod),
      Result.succeed("https://1.1.1.1/")
    );
  });

  it("rejects other protocols, credentials and invalid URLs", () => {
    assert.deepStrictEqual(
      checkTargetUrl("ftp://example.com", prod),
      Result.fail("protocol_not_allowed")
    );
    assert.deepStrictEqual(
      checkTargetUrl("https://user:pass@example.com", prod),
      Result.fail("credentials_not_allowed")
    );
    assert.deepStrictEqual(
      checkTargetUrl("https://exa mple.com", prod),
      Result.fail("invalid_url")
    );
  });

  it("rejects local hostnames and private IP literals", () => {
    for (const url of [
      "http://localhost:1337",
      "https://printer.local",
      "https://api.localhost",
      "https://intranet",
    ]) {
      assert.deepStrictEqual(
        checkTargetUrl(url, prod),
        Result.fail("blocked_hostname"),
        url
      );
    }
    for (const url of [
      "https://127.0.0.1",
      "https://10.0.0.1",
      "https://192.168.1.1",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[fd00::1]",
      "https://[::ffff:10.0.0.1]",
    ]) {
      assert.deepStrictEqual(
        checkTargetUrl(url, prod),
        Result.fail("private_address"),
        url
      );
    }
  });

  it("allows loopback targets only in dev", () => {
    assert.deepStrictEqual(
      checkTargetUrl("http://localhost:1337/_dev/target", dev),
      Result.succeed("http://localhost:1337/_dev/target")
    );
    assert.isTrue(Result.isSuccess(checkTargetUrl("http://127.0.0.1", dev)));
    assert.deepStrictEqual(
      checkTargetUrl("https://10.0.0.1", dev),
      Result.fail("private_address")
    );
  });
});

describe("dev routes host guard", () => {
  it("accepts only loopback Host headers", () => {
    for (const host of [
      "localhost:1337",
      "127.0.0.1",
      "[::1]:1337",
      "LOCALHOST",
    ]) {
      assert.isTrue(isLoopbackHost(host), host);
    }
    for (const host of [
      undefined,
      "",
      "kanshi.example.workers.dev",
      "localhost.example.com",
      "10.0.0.1",
      "bad host",
    ]) {
      assert.isFalse(isLoopbackHost(host), String(host));
    }
  });
});

describe("monitor input", () => {
  const options = { devMode: false, now: 1000 };

  it("fills defaults", () => {
    const config = Result.getOrThrow(
      buildConfig("m1", { name: "Site", url: "example.com" }, options)
    );
    assert.strictEqual(config.url, "https://example.com/");
    assert.strictEqual(config.expectedStatus, "2xx");
    assert.strictEqual(config.intervalSeconds, 60);
    assert.strictEqual(config.generation, 0);
    assert.strictEqual(config.channels, "all");
  });

  it("enforces the stage's minimum interval", () => {
    const input = { intervalSeconds: 5, name: "Site", url: "example.com" };
    assert.isTrue(Result.isFailure(buildConfig("m1", input, options)));
    assert.isTrue(
      Result.isSuccess(buildConfig("m1", input, { ...options, devMode: true }))
    );
  });

  it("validates patched URLs and statuses", () => {
    const config = Result.getOrThrow(
      buildConfig("m1", { name: "Site", url: "example.com" }, options)
    );
    assert.isTrue(
      Result.isFailure(
        patchConfig(config, { url: "http://localhost" }, options)
      )
    );
    assert.isTrue(
      Result.isFailure(patchConfig(config, { expectedStatus: "9xx" }, options))
    );
    const patched = Result.getOrThrow(
      patchConfig(config, { expectedStatus: 204, name: "New" }, options)
    );
    assert.strictEqual(patched.expectedStatus, "204");
    assert.strictEqual(patched.name, "New");
  });

  it("rejects bodyContains with HEAD, on the merged config", () => {
    const headError =
      "bodyContains: cannot be used with method HEAD (a HEAD response has no body)";
    assert.deepStrictEqual(
      buildConfig(
        "m1",
        {
          bodyContains: "ok",
          method: "HEAD",
          name: "Site",
          url: "example.com",
        },
        options
      ),
      Result.fail(headError)
    );
    const withKeyword = Result.getOrThrow(
      buildConfig(
        "m1",
        { bodyContains: "ok", name: "Site", url: "example.com" },
        options
      )
    );
    // Only the method changes: the stored keyword makes it invalid.
    assert.deepStrictEqual(
      patchConfig(withKeyword, { method: "HEAD" }, options),
      Result.fail(headError)
    );
    // Clearing the keyword in the same patch is fine.
    const head = Result.getOrThrow(
      patchConfig(withKeyword, { bodyContains: null, method: "HEAD" }, options)
    );
    assert.strictEqual(head.method, "HEAD");
    // And a keyword cannot be added to a HEAD monitor.
    assert.deepStrictEqual(
      patchConfig(head, { bodyContains: "ok" }, options),
      Result.fail(headError)
    );
  });
});

const request = {
  bodyContains: null,
  expectedStatus: "2xx",
  method: "GET" as const,
  timeoutMs: 1000,
  url: "https://example.com",
};

describe("probe()", () => {
  it.effect("succeeds on an expected status", () =>
    Effect.gen(function* probeOk() {
      const client = answering(200, "ok");
      const outcome = yield* probe(request).pipe(Effect.provide(client.layer));
      assert.isTrue(outcome.ok);
      assert.strictEqual(outcome.status, 200);
      assert.strictEqual(outcome.latencyMs, 0);
      const [sent] = client.sent;
      assert.strictEqual(sent?.request.method, "GET");
      assert.strictEqual(sent?.request.url, "https://example.com");
      assert.strictEqual(
        sent?.request.headers["user-agent"],
        "Kanshi uptime monitor"
      );
      assert.strictEqual(sent?.redirect, "follow");
      // The request is released once the probe is done with it.
      assert.isTrue(sent?.signal.aborted);
    })
  );

  it.effect("measures latency up to the end of the body", () =>
    Effect.gen(function* probeLatency() {
      const client = testHttpClient(() =>
        Effect.sleep(300).pipe(Effect.as(new Response("ok")))
      );
      const fiber = yield* probe(request).pipe(
        Effect.provide(client.layer),
        Effect.forkChild
      );
      yield* TestClock.adjust(300);
      const outcome = yield* Fiber.join(fiber);
      assert.isTrue(outcome.ok);
      assert.strictEqual(outcome.latencyMs, 300);
    })
  );

  it.effect("fails with status on an unexpected status", () =>
    Effect.gen(function* probeStatus() {
      const outcome = yield* probe(request).pipe(
        Effect.provide(answering(503).layer)
      );
      assert.isFalse(outcome.ok);
      assert.strictEqual(outcome.errorKind, "status");
      assert.strictEqual(outcome.status, 503);
      assert.strictEqual(outcome.message, "expected 2xx, got 503");
      assert.isNull(outcome.responseExcerpt);
    })
  );

  it.effect("keeps the start of a failed response's body", () =>
    Effect.gen(function* probeExcerpt() {
      const body = '{"_tag":"ServiceUnavailable","details":{"ok":false}}';
      const outcome = yield* probe(request).pipe(
        Effect.provide(answering(503, body).layer)
      );
      assert.strictEqual(outcome.errorKind, "status");
      assert.deepStrictEqual(outcome.responseExcerpt, {
        text: body,
        truncated: false,
      });
      // A keyword failure keeps it too.
      const keyword = yield* probe({
        ...request,
        bodyContains: "healthy",
      }).pipe(Effect.provide(answering(200, "degraded").layer));
      assert.deepStrictEqual(keyword.responseExcerpt, {
        text: "degraded",
        truncated: false,
      });
      // A success keeps none, though a GET reads its body.
      const ok = yield* probe(request).pipe(
        Effect.provide(answering(200, "ok").layer)
      );
      assert.isNull(ok.responseExcerpt);
    })
  );

  it.effect("caps the excerpt at 2 KB, on a character boundary", () =>
    Effect.gen(function* probeExcerptCap() {
      const long = yield* probe(request).pipe(
        Effect.provide(answering(500, "a".repeat(5000)).layer)
      );
      assert.deepStrictEqual(long.responseExcerpt, {
        text: "a".repeat(excerptBytes),
        truncated: true,
      });
      const exact = yield* probe(request).pipe(
        Effect.provide(answering(500, "b".repeat(excerptBytes)).layer)
      );
      assert.isFalse(exact.responseExcerpt?.truncated);
      // "é" is two bytes: the character cut at byte 2048 is dropped whole.
      const accented = yield* probe(request).pipe(
        Effect.provide(answering(500, `x${"é".repeat(1500)}`).layer)
      );
      assert.strictEqual(
        accented.responseExcerpt?.text,
        `x${"é".repeat(1023)}`
      );
      assert.isTrue(accented.responseExcerpt?.truncated);
      // A blank body is no excerpt.
      const blank = yield* probe(request).pipe(
        Effect.provide(answering(503, " \n").layer)
      );
      assert.isNull(blank.responseExcerpt);
    })
  );

  it.effect("reads only 2 KB of a failed HEAD response for the excerpt", () =>
    Effect.gen(function* probeHeadExcerpt() {
      const chunkBytes = 512;
      const endless = endlessBody(chunkBytes);
      const client = testHttpClient(() =>
        Effect.succeed(new Response(endless.body, { status: 503 }))
      );
      const outcome = yield* probe({ ...request, method: "HEAD" }).pipe(
        Effect.provide(client.layer)
      );
      assert.strictEqual(outcome.errorKind, "status");
      assert.deepStrictEqual(outcome.responseExcerpt, {
        text: "x".repeat(excerptBytes),
        truncated: true,
      });
      assert.isTrue(endless.seen.cancelled);
      assert.isAtMost(
        endless.seen.pulled * chunkBytes,
        excerptBytes + 3 * chunkBytes
      );
    })
  );

  it.effect("checks the body for a keyword", () =>
    Effect.gen(function* probeKeyword() {
      const keyword = { ...request, bodyContains: "healthy" };
      const missing = yield* probe(keyword).pipe(
        Effect.provide(answering(200, "degraded").layer)
      );
      assert.strictEqual(missing.errorKind, "keyword");
      const found = yield* probe(keyword).pipe(
        Effect.provide(answering(200, "all healthy").layer)
      );
      assert.isTrue(found.ok);
      // A HEAD monitor with a keyword reads the (empty) body too.
      const head = yield* probe({ ...keyword, method: "HEAD" }).pipe(
        Effect.provide(answering(200, null).layer)
      );
      assert.strictEqual(head.errorKind, "keyword");
    })
  );

  it.effect("does not read the body of a HEAD probe without a keyword", () =>
    Effect.gen(function* probeHead() {
      const endless = endlessBody(512);
      const client = testHttpClient(() =>
        Effect.succeed(new Response(endless.body))
      );
      const outcome = yield* probe({ ...request, method: "HEAD" }).pipe(
        Effect.provide(client.layer)
      );
      assert.isTrue(outcome.ok);
      assert.isNull(outcome.responseExcerpt);
      assert.strictEqual(client.sent[0]?.request.method, "HEAD");
      assert.isTrue(client.sent[0]?.signal.aborted);
      assert.isAtMost(endless.seen.pulled, 1);
    })
  );

  it.effect("only reads the first megabyte of the body", () =>
    Effect.gen(function* probeBounded() {
      const big = `${"a".repeat(maxBodyBytes)}needle`;
      const outcome = yield* probe({ ...request, bodyContains: "needle" }).pipe(
        Effect.provide(answering(200, big).layer)
      );
      assert.strictEqual(outcome.errorKind, "keyword");
    })
  );

  it.effect("stops reading an endless body after the first megabyte", () =>
    Effect.gen(function* probeEndless() {
      const chunkBytes = 64 * 1024;
      const endless = endlessBody(chunkBytes);
      const client = testHttpClient(() =>
        Effect.succeed(new Response(endless.body))
      );
      const outcome = yield* probe({ ...request, bodyContains: "needle" }).pipe(
        Effect.provide(client.layer)
      );
      assert.strictEqual(outcome.errorKind, "keyword");
      assert.isTrue(endless.seen.cancelled);
      // The stream may pull ahead a chunk or two, never much more.
      assert.isAtMost(
        endless.seen.pulled * chunkBytes,
        maxBodyBytes + 3 * chunkBytes
      );
    })
  );

  it.effect("times out, and aborts the request", () =>
    Effect.gen(function* probeTimeout() {
      const client = hanging();
      const fiber = yield* probe({ ...request, timeoutMs: 50 }).pipe(
        Effect.provide(client.layer),
        Effect.forkChild
      );
      yield* TestClock.adjust(49);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.errorKind, "timeout");
      assert.strictEqual(outcome.message, "no response within 50ms");
      assert.isNull(outcome.latencyMs);
      assert.isTrue(client.sent[0]?.signal.aborted);
    })
  );

  it.effect("times out on a body that stalls", () =>
    Effect.gen(function* probeStalledBody() {
      // Headers arrive, the body never does.
      const stalled = new ReadableStream<Uint8Array>();
      const client = testHttpClient(() =>
        Effect.succeed(new Response(stalled))
      );
      const fiber = yield* probe({ ...request, timeoutMs: 50 }).pipe(
        Effect.provide(client.layer),
        Effect.forkChild
      );
      yield* TestClock.adjust(50);
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.errorKind, "timeout");
      assert.isTrue(client.sent[0]?.signal.aborted);
    })
  );

  it.effect("keeps a failed HEAD status when its body stalls", () =>
    Effect.gen(function* probeHeadStalled() {
      const client = testHttpClient(() =>
        Effect.succeed(
          new Response(new ReadableStream<Uint8Array>(), { status: 503 })
        )
      );
      const fiber = yield* probe({
        ...request,
        method: "HEAD",
        timeoutMs: 10_000,
      }).pipe(Effect.provide(client.layer), Effect.forkChild);
      yield* TestClock.adjust(excerptReadMs - 1);
      assert.isUndefined(fiber.pollUnsafe());
      // The excerpt read has its own bound, well within the timeout.
      yield* TestClock.adjust(1);
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.errorKind, "status");
      assert.strictEqual(outcome.status, 503);
      assert.strictEqual(outcome.message, "expected 2xx, got 503");
      assert.strictEqual(outcome.latencyMs, 0);
      assert.isNull(outcome.responseExcerpt);
      assert.isTrue(client.sent[0]?.signal.aborted);
    })
  );

  it.effect("keeps the excerpt read before a failed GET body stalls", () =>
    Effect.gen(function* probeGetStalled() {
      const partial = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode("partial error"));
        },
      });
      const client = testHttpClient(() =>
        Effect.succeed(new Response(partial, { status: 500 }))
      );
      const fiber = yield* probe({ ...request, timeoutMs: 10_000 }).pipe(
        Effect.provide(client.layer),
        Effect.forkChild
      );
      yield* TestClock.adjust(excerptReadMs);
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.errorKind, "status");
      assert.strictEqual(outcome.status, 500);
      // Cut off: marked truncated.
      assert.deepStrictEqual(outcome.responseExcerpt, {
        text: "partial error",
        truncated: true,
      });
    })
  );

  it.effect("keeps a failed status when its body read errors", () =>
    Effect.gen(function* probeBodyError() {
      const broken = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          controller.error(new Error("Network connection lost."));
        },
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode("oops"));
        },
      });
      const outcome = yield* probe(request).pipe(
        Effect.provide(
          testHttpClient(() =>
            Effect.succeed(new Response(broken, { status: 502 }))
          ).layer
        )
      );
      assert.strictEqual(outcome.errorKind, "status");
      assert.strictEqual(outcome.status, 502);
      assert.deepStrictEqual(outcome.responseExcerpt, {
        text: "oops",
        truncated: true,
      });
    })
  );

  it.effect("keeps a failed status whose body stalls near the timeout", () =>
    Effect.gen(function* probeStalledAtDeadline() {
      // Headers after 200 ms of a 300 ms budget: 100 ms left for the excerpt.
      const client = testHttpClient(() =>
        Effect.sleep(200).pipe(
          Effect.as(
            new Response(new ReadableStream<Uint8Array>(), { status: 503 })
          )
        )
      );
      for (const method of ["GET", "HEAD"] as const) {
        const fiber = yield* probe({ ...request, method, timeoutMs: 300 }).pipe(
          Effect.provide(client.layer),
          Effect.forkChild
        );
        yield* TestClock.adjust(300);
        const outcome = yield* Fiber.join(fiber);
        assert.strictEqual(outcome.errorKind, "status");
        assert.strictEqual(outcome.status, 503);
        assert.strictEqual(outcome.latencyMs, 200);
        assert.isNull(outcome.responseExcerpt);
      }
    })
  );

  it.effect("retries once when a pooled connection was lost", () =>
    Effect.gen(function* probeRetry() {
      const flaky = testHttpClient(() =>
        flaky.sent.length === 1
          ? Effect.fail(new Error("Network connection lost."))
          : Effect.succeed(new Response("ok"))
      );
      const outcome = yield* probe(request).pipe(Effect.provide(flaky.layer));
      assert.isTrue(outcome.ok);
      assert.strictEqual(flaky.sent.length, 2);

      const down = rejecting(new Error("Network connection lost."));
      const failed = yield* probe(request).pipe(Effect.provide(down.layer));
      assert.strictEqual(failed.errorKind, "connection");
      assert.strictEqual(failed.message, "Network connection lost.");
      assert.strictEqual(down.sent.length, 2);

      // Other errors are not retried.
      const refused = rejecting(new Error("connection refused"));
      yield* probe(request).pipe(Effect.provide(refused.layer));
      assert.strictEqual(refused.sent.length, 1);
    })
  );

  it.effect("classifies transport errors", () =>
    Effect.gen(function* probeErrors() {
      const outcome = yield* probe(request).pipe(
        Effect.provide(
          rejecting(new TypeError("Network connection lost.")).layer
        )
      );
      assert.strictEqual(outcome.errorKind, "connection");
      // The fetch rejection is classified, not the client's error (whose
      // message carries the URL).
      const unknown = yield* probe({
        ...request,
        url: "https://tls-dns-timeout.example.com",
      }).pipe(Effect.provide(rejecting(new Error("boom")).layer));
      assert.strictEqual(unknown.errorKind, "network");
      assert.strictEqual(unknown.message, "boom");
      // Transport errors have no excerpt.
      assert.isNull(outcome.responseExcerpt);
      assert.isNull(unknown.responseExcerpt);
      assert.strictEqual(
        classifyFetchError(new Error("DNS lookup failed")),
        "dns"
      );
      assert.strictEqual(
        classifyFetchError(new Error("TLS handshake failed")),
        "tls"
      );
      assert.strictEqual(
        classifyFetchError(new Error("fetch failed", { cause: "timed out" })),
        "timeout"
      );
      assert.strictEqual(classifyFetchError(new Error("boom")), "network");
    })
  );

  it.effect("classifies an error that ends the body read", () =>
    Effect.gen(function* probeBodyError() {
      const broken = new ReadableStream<Uint8Array>({
        pull: (controller) =>
          controller.error(new Error("connection reset by peer")),
      });
      const outcome = yield* probe(request).pipe(
        Effect.provide(
          testHttpClient(() => Effect.succeed(new Response(broken))).layer
        )
      );
      assert.strictEqual(outcome.errorKind, "connection");
      assert.strictEqual(outcome.message, "connection reset by peer");
    })
  );
});

describe(overallStatus, () => {
  it("derives the overall status from the monitors", () => {
    assert.strictEqual(overallStatus([]), "operational");
    assert.strictEqual(
      overallStatus([{ status: "up" }, { status: "unknown" }]),
      "operational"
    );
    assert.strictEqual(
      overallStatus([{ status: "up" }, { status: "down" }]),
      "partial_outage"
    );
    assert.strictEqual(
      overallStatus([{ status: "down" }, { status: "paused" }]),
      "major_outage"
    );
  });
});
