import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { isLoopbackHost } from "../../src/dev/routes.ts";
import {
  matchesExpectedStatus,
  parseExpectedStatus,
} from "../../src/domain/expected-status.ts";
import { buildConfig, patchConfig } from "../../src/domain/monitor-input.ts";
import type { FetchLike } from "../../src/domain/probe.ts";
import { classifyFetchError, probe } from "../../src/domain/probe.ts";
import { checkTargetUrl } from "../../src/domain/url.ts";

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
    assert.strictEqual(config.key, "m1");
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

const respond =
  (status: number, body = "ok"): FetchLike =>
  () =>
    Promise.resolve(new Response(body, { status }));

// Never responds; rejects when the probe's timeout signal aborts.
const hang: FetchLike = (_url, init) =>
  // oxlint-disable-next-line promise/avoid-new -- models a hanging fetch
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

const request = {
  bodyContains: null,
  expectedStatus: "2xx",
  method: "GET" as const,
  timeoutMs: 1000,
  url: "https://example.com",
};

describe("probe()", () => {
  it.live("succeeds on an expected status", () =>
    Effect.gen(function* probeOk() {
      const outcome = yield* probe(request, respond(200));
      assert.isTrue(outcome.ok);
      assert.strictEqual(outcome.status, 200);
      assert.isNotNull(outcome.latencyMs);
    })
  );

  it.live("fails with status on an unexpected status", () =>
    Effect.gen(function* probeStatus() {
      const outcome = yield* probe(request, respond(503));
      assert.isFalse(outcome.ok);
      assert.strictEqual(outcome.errorKind, "status");
      assert.strictEqual(outcome.status, 503);
    })
  );

  it.live("checks the body for a keyword", () =>
    Effect.gen(function* probeKeyword() {
      const missing = yield* probe(
        { ...request, bodyContains: "healthy" },
        respond(200, "degraded")
      );
      assert.strictEqual(missing.errorKind, "keyword");
      const found = yield* probe(
        { ...request, bodyContains: "healthy" },
        respond(200, "all healthy")
      );
      assert.isTrue(found.ok);
    })
  );

  it.live("only reads the first megabyte of the body", () =>
    Effect.gen(function* probeBounded() {
      const big = `${"a".repeat(1024 * 1024)}needle`;
      const outcome = yield* probe(
        { ...request, bodyContains: "needle" },
        respond(200, big)
      );
      assert.strictEqual(outcome.errorKind, "keyword");
    })
  );

  it.live("times out", () =>
    Effect.gen(function* probeTimeout() {
      const outcome = yield* probe({ ...request, timeoutMs: 50 }, hang);
      assert.strictEqual(outcome.errorKind, "timeout");
      assert.isNull(outcome.latencyMs);
    })
  );

  it.live("retries once when a pooled connection was lost", () =>
    Effect.gen(function* probeRetry() {
      let calls = 0;
      const flaky: FetchLike = () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("Network connection lost."))
          : Promise.resolve(new Response("ok"));
      };
      const outcome = yield* probe(request, flaky);
      assert.isTrue(outcome.ok);
      assert.strictEqual(calls, 2);

      let refused = 0;
      const down: FetchLike = () => {
        refused += 1;
        return Promise.reject(new Error("Network connection lost."));
      };
      const failed = yield* probe(request, down);
      assert.strictEqual(failed.errorKind, "connection");
      assert.strictEqual(refused, 2);
    })
  );

  it.live("classifies transport errors", () =>
    Effect.gen(function* probeErrors() {
      const outcome = yield* probe(request, () =>
        Promise.reject(new TypeError("Network connection lost."))
      );
      assert.strictEqual(outcome.errorKind, "connection");
      assert.strictEqual(
        classifyFetchError(new Error("DNS lookup failed"), false),
        "dns"
      );
      assert.strictEqual(
        classifyFetchError(new Error("TLS handshake failed"), false),
        "tls"
      );
      assert.strictEqual(
        classifyFetchError(new Error("boom"), false),
        "network"
      );
      assert.strictEqual(
        classifyFetchError(new Error("boom"), true),
        "timeout"
      );
    })
  );
});
