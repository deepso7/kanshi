// Phase 1 spike stack. Run with `pnpm exec alchemy dev spike/alchemy.run.ts`.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import SpikeWorker from "./worker.ts";

export default Alchemy.Stack(
  "KanshiSpike",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* KanshiSpikeStack() {
    const worker = yield* SpikeWorker;
    return { url: worker.url };
  })
);
