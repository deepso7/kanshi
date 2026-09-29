import { assert, describe, it } from "@effect/vitest";

import { isWorkerPath, runWorkerFirst } from "../../src/http/worker-paths.ts";

describe(isWorkerPath, () => {
  it("matches each prefix and the paths below it", () => {
    for (const path of [
      "/api",
      "/api/monitors",
      "/api/session",
      "/_dev/events",
      "/login",
      "/monitors/abc/edit",
      "/channels",
    ]) {
      assert.isTrue(isWorkerPath(path), path);
    }
  });

  it("leaves the SPA's paths to the static assets", () => {
    for (const path of ["/", "/status", "/apis", "/api-docs", "/loginx"]) {
      assert.isFalse(isWorkerPath(path), path);
    }
  });
});

describe("the run_worker_first rules", () => {
  it("lists each prefix and its subtree as Cloudflare rules", () => {
    assert.includeMembers(runWorkerFirst, ["/api", "/api/*", "/_dev/*"]);
    for (const rule of runWorkerFirst) {
      assert.match(rule, /^\/[\w-]+(?:\/\*)?$/u);
    }
  });
});
