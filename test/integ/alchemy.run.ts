// The Kanshi Worker in dev mode for the integration tests (run locally by
// `Test.make({ dev: true })`, no Cloudflare account needed).
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import Kanshi from "../../src/worker.ts";

export const apiToken = "integration-api-token";
export const monitorQuota = 15;

export default Alchemy.Stack(
  "KanshiIntegration",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* KanshiIntegrationStack() {
    const worker = yield* Kanshi.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          KANSHI_API_TOKEN: apiToken,
          KANSHI_DEV_MODE: "true",
          KANSHI_MONITOR_QUOTA: String(monitorQuota),
        })
      )
    );
    return { url: worker.url.as<string>() };
  })
);
