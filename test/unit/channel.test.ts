import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { checkChannelUrl, hashUrl, maskUrl } from "../../src/domain/channel.ts";
import { buildConfig, patchConfig } from "../../src/domain/monitor-input.ts";

const prod = { devMode: false };
const dev = { devMode: true };

describe("channel URL rules", () => {
  it("requires https in production and normalises", () => {
    assert.deepStrictEqual(
      checkChannelUrl("https://hooks.slack.com/services/T0/B0/xyz", prod),
      Result.succeed("https://hooks.slack.com/services/T0/B0/xyz")
    );
    assert.deepStrictEqual(
      checkChannelUrl("ntfy.sh/my-topic", prod),
      Result.succeed("https://ntfy.sh/my-topic")
    );
    assert.deepStrictEqual(
      checkChannelUrl("http://example.com/hook", prod),
      Result.fail("url: alert channel URLs must use https")
    );
  });

  it("applies the target URL rules", () => {
    for (const url of [
      "https://user:pass@example.com/hook",
      "https://10.0.0.1/hook",
      "https://intranet/hook",
      "ftp://example.com",
      "http://localhost:1337/_dev/webhook",
    ]) {
      assert.isTrue(Result.isFailure(checkChannelUrl(url, prod)), url);
    }
  });

  it("allows http only for loopback hosts in dev", () => {
    assert.deepStrictEqual(
      checkChannelUrl("http://localhost:1337/_dev/webhook", dev),
      Result.succeed("http://localhost:1337/_dev/webhook")
    );
    assert.isTrue(Result.isSuccess(checkChannelUrl("http://127.0.0.1/", dev)));
    assert.isTrue(
      Result.isFailure(checkChannelUrl("http://example.com/hook", dev))
    );
    assert.isTrue(
      Result.isSuccess(checkChannelUrl("https://example.com/hook", dev))
    );
  });
});

describe("channel URL secrecy", () => {
  it("masks all but the origin and, for long URLs, the last 4 characters", () => {
    assert.strictEqual(
      maskUrl("https://hooks.slack.com/services/T0/B0/secretXYZ9"),
      "https://hooks.slack.com/****XYZ9"
    );
    assert.strictEqual(maskUrl("https://ntfy.sh/abc"), "https://ntfy.sh/****");
    assert.strictEqual(maskUrl("not a url"), "****");
  });

  it.effect("hashes with SHA-256 hex", () =>
    Effect.gen(function* hashTest() {
      assert.strictEqual(
        yield* hashUrl("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      );
    })
  );
});

describe("monitor channel selection", () => {
  const options = { devMode: false, now: 1000 };

  it("defaults to all and de-duplicates explicit lists", () => {
    const base = Result.getOrThrow(
      buildConfig("m1", { name: "Site", url: "example.com" }, options)
    );
    assert.strictEqual(base.channels, "all");
    const listed = Result.getOrThrow(
      buildConfig(
        "m1",
        { channels: ["a", "b", "a"], name: "Site", url: "example.com" },
        options
      )
    );
    assert.deepStrictEqual(listed.channels, ["a", "b"]);
    const patched = Result.getOrThrow(
      patchConfig(base, { channels: ["c", "c"] }, options)
    );
    assert.deepStrictEqual(patched.channels, ["c"]);
  });
});
