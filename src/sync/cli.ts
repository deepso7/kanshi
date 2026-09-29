// The `kanshi` command line: `kanshi sync [--url <base>] [--config <path>]
// [--dry-run] [--adopt] [--wait <seconds>]`. `scripts/kanshi.ts` runs it
// with the Bun services and a fetch-based HttpClient.
//
// Settings come from `Config` (Effect's default provider reads the
// environment, and Bun loads .env): KANSHI_API_TOKEN (required, redacted),
// KANSHI_URL (when --url is not given) and the channel URLs written as
// env("NAME") in the config file.
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as CliConfig from "effect/unstable/cli/CliConfig";
import * as CliError from "effect/unstable/cli/CliError";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";

import packageJson from "../../package.json" with { type: "json" };
import { KanshiConfig } from "../config.ts";
import { SyncError, sync } from "./sync.ts";

/** The parsed `kanshi sync` flags. */
export interface SyncArgs {
  readonly adopt: boolean;
  /** `--url`, else KANSHI_URL. */
  readonly baseUrl: string;
  /** `--config`: the config file to load. */
  readonly config: string;
  readonly dryRun: boolean;
  readonly waitSeconds: number;
}

/** KANSHI_API_TOKEN: required by `kanshi sync`, never printed. */
export const apiToken: Effect.Effect<
  Redacted.Redacted<string>,
  SyncError
> = Config.option(Config.Redacted("KANSHI_API_TOKEN")).pipe(
  Effect.mapError(
    (cause) =>
      new SyncError({
        message: `cannot read KANSHI_API_TOKEN: ${cause.message}`,
      })
  ),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        Effect.fail(
          new SyncError({
            message:
              "KANSHI_API_TOKEN is not set (add it to .env or the environment)",
          })
        ),
      onSome: Effect.succeed,
    })
  )
);

const ConfigModule = Schema.Struct({ default: Schema.Unknown });

/** Import `file` and decode its default export as a `KanshiConfig`. */
const loadConfig = (file: string) =>
  Effect.tryPromise({
    catch: (cause) =>
      new SyncError({
        message: `cannot load ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    try: () => import(pathToFileURL(path.resolve(file)).href),
  }).pipe(
    Effect.flatMap((module) =>
      Schema.decodeUnknownEffect(ConfigModule)(module).pipe(
        Effect.mapError(
          () => new SyncError({ message: `${file} has no default export` })
        )
      )
    ),
    Effect.flatMap(({ default: config }) =>
      Schema.decodeUnknownEffect(KanshiConfig)(config, {
        errors: "all",
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SyncError({
              message: `invalid config ${file}:\n${cause.message}`,
            })
        )
      )
    )
  );

/**
 * A `SyncError` as a CLI user error: `Command.run` prints it (continuation
 * lines indented under "ERROR") without a stack trace, and exits with 1.
 */
const toUserError = (error: SyncError) =>
  new CliError.UserError({
    cause: error,
    userMessage: error.message.replaceAll("\n", "\n  "),
  });

/** `kanshi sync`: load the config file and apply it to the Worker. */
export const runSync = Effect.fn("kanshi.cli.sync")(function* runSyncEffect(
  args: SyncArgs
) {
  const token = yield* apiToken;
  const config = yield* loadConfig(args.config);
  yield* Console.log(
    `Syncing ${args.config} to ${args.baseUrl}${args.dryRun ? " (dry run)" : ""}`
  );
  yield* sync({
    adopt: args.adopt,
    baseUrl: args.baseUrl,
    config,
    dryRun: args.dryRun,
    token,
    waitSeconds: args.waitSeconds,
  });
}, Effect.mapError(toUserError));

const syncFlags = {
  adopt: Flag.Boolean("adopt").pipe(
    Flag.withDescription(
      "Take over dashboard-created resources with the same key"
    ),
    Flag.withDefault(false)
  ),
  baseUrl: Flag.String("url").pipe(
    Flag.withMetavar("<base>"),
    Flag.withDescription("Worker URL (default: $KANSHI_URL)"),
    Flag.withSchema(Schema.NonEmptyString),
    Flag.withFallbackConfig(Config.NonEmptyString("KANSHI_URL"))
  ),
  config: Flag.String("config").pipe(
    Flag.withMetavar("<path>"),
    Flag.withDescription("Config file (default: kanshi.config.ts)"),
    Flag.withDefault("kanshi.config.ts")
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the plan without changing anything"),
    Flag.withDefault(false)
  ),
  waitSeconds: Flag.Int("wait").pipe(
    Flag.withMetavar("<seconds>"),
    Flag.withDescription("Retry connecting for this long (default: 0)"),
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDefault(0)
  ),
} as const;

/**
 * The `kanshi` command with `handler` as `kanshi sync`. Private; exported
 * for tests (which pass a handler that records the parsed flags).
 */
export const makeKanshi = <E, R>(
  handler: (args: SyncArgs) => Effect.Effect<void, E, R>
) =>
  Command.make("kanshi").pipe(
    Command.withDescription("Manage a self-hosted Kanshi uptime monitor."),
    Command.withSubcommands([
      Command.make("sync", syncFlags, handler).pipe(
        Command.withShortDescription(
          "Apply a Kanshi config file to a running Kanshi Worker"
        ),
        Command.withDescription(
          'Apply a Kanshi config file to a running Kanshi Worker. Only resources created by sync (managed) are updated or deleted. Needs KANSHI_API_TOKEN; channel URLs written as env("NAME") are read from the environment.'
        ),
        Command.withExamples([
          {
            command:
              "kanshi sync --url https://kanshi.example.workers.dev --dry-run",
            description: "Show the plan without changing anything",
          },
          {
            command:
              "kanshi sync --config kanshi.dev.config.ts --url http://localhost:1337 --adopt --wait 30",
            description: "Seed the local dev stack (pnpm seed)",
          },
        ])
      ),
    ])
  );

export const kanshi = makeKanshi(runSync);

/** Only --help/-h and --version/-v; no wizard, completions or log level. */
export const cliConfig = CliConfig.layer({
  builtIns: [GlobalFlag.Help, GlobalFlag.Version],
});

/** `kanshi --version`. */
export const { version } = packageJson;
