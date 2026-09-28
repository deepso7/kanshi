// `pnpm kanshi sync [--url <base>] [--config <path>] [--dry-run] [--adopt]`
//
// Applies kanshi.config.ts to a running Kanshi Worker over its API. Reads
// KANSHI_API_TOKEN, and KANSHI_URL when --url is not given (Bun loads
// .env). Channel URLs given as env("NAME") are read from the environment.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { KanshiConfig } from "../src/config.ts";
import { SyncError, sync } from "../src/sync/sync.ts";

const usage = `Usage: pnpm kanshi sync [options]

Applies a Kanshi config file to a running Kanshi Worker. Only resources
created by sync (managed) are updated or deleted.

Options:
  --url <base>       Worker URL (default: $KANSHI_URL)
  --config <path>    Config file (default: kanshi.config.ts)
  --dry-run          Print the plan without changing anything
  --adopt            Take over dashboard-created resources with the same key
  --wait <seconds>   Retry connecting for this long (default: 0)
  -h, --help         Show this help

Environment: KANSHI_API_TOKEN (required), KANSHI_URL.`;

// oxlint-disable-next-line no-console -- CLI output
const log = (line: string) => console.log(line);

const fail = (message: string) => Effect.fail(new SyncError({ message }));

const loadConfig = (file: string) =>
  Effect.tryPromise({
    catch: (cause) =>
      new SyncError({
        message: `cannot load ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    try: () =>
      import(pathToFileURL(path.resolve(file)).href) as Promise<{
        readonly default?: unknown;
      }>,
  }).pipe(
    Effect.flatMap((module) =>
      Schema.decodeUnknownEffect(KanshiConfig)(module.default, {
        errors: "all",
        onExcessProperty: "error",
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof SyncError
        ? cause
        : new SyncError({
            message: `invalid config ${file}:\n${cause.message}`,
          })
    )
  );

const main = Effect.gen(function* main() {
  const { positionals, values } = yield* Effect.try({
    catch: (cause) =>
      new SyncError({
        message: `${cause instanceof Error ? cause.message : String(cause)}\n\n${usage}`,
      }),
    try: () =>
      parseArgs({
        allowPositionals: true,
        args: process.argv.slice(2),
        options: {
          adopt: { type: "boolean" },
          config: { type: "string" },
          "dry-run": { type: "boolean" },
          help: { short: "h", type: "boolean" },
          url: { type: "string" },
          wait: { type: "string" },
        },
      }),
  });
  if (values.help === true) {
    yield* Console.log(usage);
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "sync") {
    return yield* fail(usage);
  }
  const baseUrl = values.url ?? process.env.KANSHI_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return yield* fail("no Worker URL: pass --url <base> or set KANSHI_URL");
  }
  const token = process.env.KANSHI_API_TOKEN;
  if (token === undefined || token.length === 0) {
    return yield* fail("KANSHI_API_TOKEN is not set");
  }
  const waitSeconds = Number(values.wait ?? 0);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0) {
    return yield* fail("--wait must be a whole number of seconds");
  }
  const file = values.config ?? "kanshi.config.ts";
  const config = yield* loadConfig(file);
  const dryRun = values["dry-run"] === true;

  log(`Syncing ${file} to ${baseUrl}${dryRun ? " (dry run)" : ""}`);
  yield* sync({
    adopt: values.adopt === true,
    baseUrl,
    config,
    dryRun,
    environment: process.env,
    log,
    token,
    waitSeconds,
  });
});

main.pipe(
  Effect.catchTag("SyncError", (problem) =>
    Console.error(problem.message).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        })
      )
    )
  ),
  Effect.provide(FetchHttpClient.layer),
  BunRuntime.runMain
);
