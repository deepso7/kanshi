// `pnpm kanshi sync [--url <base>] [--config <path>] [--dry-run] [--adopt]
// [--wait <seconds>]`; `pnpm kanshi --help` for the rest.
//
// Applies kanshi.config.ts to a running Kanshi Worker over its API. The
// command is defined in src/sync/cli.ts; this runs it on Bun (which loads
// .env) with a fetch-based HttpClient.
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { cliConfig, kanshi, version } from "../src/sync/cli.ts";

kanshi.pipe(
  Command.run({ version }),
  Effect.provide(
    Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, cliConfig)
  ),
  BunRuntime.runMain
);
