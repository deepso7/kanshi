import { assert, describe, it } from "@effect/vitest";

import {
  deployStage,
  deployWorkerName,
  devStages,
  stateStoreFor,
  workerNameFor,
} from "../../src/stages.ts";

// `pnpm dev` and the integration tests' stages (`test/integ/*.test.ts`).
const localStages = [
  "dev",
  "integ",
  "integ-alerts",
  "integ-history",
  "integ-ui",
  "integ-watchdog",
];

describe(workerNameFor, () => {
  it("names the deployed Worker `kanshi`", () => {
    assert.strictEqual(deployStage, "prod");
    assert.strictEqual(workerNameFor("prod"), "kanshi");
  });

  it("leaves every other stage to Alchemy's generated name", () => {
    for (const stage of [...localStages, "Prod", "prod-2", "staging"]) {
      assert.isUndefined(workerNameFor(stage), stage);
    }
  });

  it("is a valid workers.dev DNS label", () => {
    assert.match(deployWorkerName, /^[a-z][a-z0-9-]{0,62}$/u);
  });
});

describe(stateStoreFor, () => {
  it("keeps the deploy stage's state in Cloudflare", () => {
    assert.strictEqual(stateStoreFor("prod"), "cloudflare");
  });

  it("keeps local stages' state in .alchemy/, offline", () => {
    for (const stage of localStages) {
      assert.strictEqual(stateStoreFor(stage), "local", stage);
    }
  });

  it("never gives a dev-mode stage Cloudflare state", () => {
    for (const stage of devStages) {
      assert.strictEqual(stateStoreFor(stage), "local", stage);
    }
  });
});
