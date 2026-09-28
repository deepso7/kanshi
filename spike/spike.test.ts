// Phase 1 spike: can the alchemy Bun test helper run the stack locally?
// Run with: CLOUDFLARE_ACCOUNT_ID=000...0 CLOUDFLARE_API_TOKEN=x bun test spike/spike.test.ts
import { expect } from "bun:test";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import Stack from "./alchemy.run.ts";

const { afterAll, beforeAll, deploy, destroy, test } = Test.make({
  dev: true,
  providers: Cloudflare.providers(),
  stage: "spiketest",
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack), { timeout: 120_000 });
afterAll(destroy(Stack), { timeout: 120_000 });

test(
  "alarm fires and reaches the registry under the local test harness",
  Effect.gen(function* alarmTest() {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    yield* client
      .post(`${url}/monitor/t1/configure?interval=1000`)
      .pipe(
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 10 })
      );
    const fires = yield* client.get(`${url}/monitor/t1`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((body) => (body as { fires: unknown[] }).fires.length),
      Effect.filterOrFail((n) => n >= 2),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 })
    );
    expect(fires).toBeGreaterThanOrEqual(2);
  }),
  { timeout: 60_000 }
);
