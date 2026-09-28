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
