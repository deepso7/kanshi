// The Kanshi stack: one Worker (the SPA as static assets, API, watchdog
// cron hourly) hosting the Monitor and Registry Durable Objects.
// `KANSHI_API_TOKEN` (from .env or the environment) is deployed as a secret.
// - `pnpm dev`: stage `dev`, run locally by `alchemy dev` (dev mode on),
//   plus the SPA's Vite dev server (HMR) proxying the API to the Worker.
// - `pnpm run deploy` / `pnpm run destroy`: stage `prod` on Cloudflare (`deploy`
//   builds the SPA first), as the Worker `kanshi`. Its state is kept in the
//   account's Cloudflare state store; other stages keep theirs in `.alchemy/`
//   (see `src/stages.ts` and `src/state-store.ts`).
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { devStages } from "./src/stages.ts";
import { state } from "./src/state-store.ts";
import Kanshi, { webAssetsDirectory } from "./src/worker.ts";

export default Alchemy.Stack(
  "Kanshi",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* KanshiStack() {
    const stage = yield* Alchemy.Stage;
    // "local" only under `alchemy dev` (and not forced remote).
    const local = (yield* Alchemy.ProviderMode.defaultProviderMode) === "local";
    if (local) {
      // The local runtime refuses a missing assets directory; `pnpm dev`
      // serves the SPA from Vite, so it need not be built.
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(webAssetsDirectory, { recursive: true })
        .pipe(Effect.orDie);
    }
    const config = yield* ConfigProvider.ConfigProvider;
    const worker = yield* Kanshi.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({
            KANSHI_DEV_MODE: String(local && devStages.has(stage)),
          }),
          config
        )
      )
    );
    if (local && devStages.has(stage)) {
      // The SPA with HMR; it proxies the Worker's paths to `worker.url`.
      const web = yield* Command.Dev("Web", {
        command: "pnpm exec vite web",
        env: {
          KANSHI_WORKER_URL: worker.url,
          // The alchemy CLI sets NODE_ENV for itself; with "production"
          // Vite would drop React Fast Refresh and StyleX its dev output.
          NODE_ENV: "development",
        },
      });
      return { url: worker.url, web: web.url };
    }
    return { url: worker.url };
  })
);
