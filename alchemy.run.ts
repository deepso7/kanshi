// The Kanshi stack: one Worker (API, dashboard, status page, watchdog cron
// every 5 minutes) hosting the Monitor and Registry Durable Objects.
// `KANSHI_API_TOKEN` (from .env or the environment) is deployed as a secret.
// - `pnpm dev`: stage `dev`, run locally by `alchemy dev` (dev mode on).
// - `pnpm deploy` / `pnpm destroy`: stage `prod` on Cloudflare. State is
//   kept in `.alchemy/` on the machine that deploys.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import Kanshi from "./src/worker.ts";

/** Stages that get dev mode: `/_dev/*` fixtures, 5s intervals, localhost. */
export const devStages = new Set(["dev"]);

export default Alchemy.Stack(
  "Kanshi",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* KanshiStack() {
    const stage = yield* Alchemy.Stage;
    const config = yield* ConfigProvider.ConfigProvider;
    const worker = yield* Kanshi.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({
            KANSHI_DEV_MODE: String(devStages.has(stage)),
          }),
          config
        )
      )
    );
    return { url: worker.url };
  })
);
