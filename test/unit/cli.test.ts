// `kanshi` argument parsing, the KANSHI_URL / KANSHI_API_TOKEN settings and
// error output, with a test ConfigProvider instead of the environment.
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";
import * as TestConsole from "effect/testing/TestConsole";
import * as CliError from "effect/unstable/cli/CliError";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { env } from "../../src/config.ts";
import type { SyncArgs } from "../../src/sync/cli.ts";
import {
  apiToken,
  cliConfig,
  makeKanshi,
  runSync,
  version,
} from "../../src/sync/cli.ts";
import { resolveDesired } from "../../src/sync/desired.ts";
import { SyncError } from "../../src/sync/sync.ts";

const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
    })
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused"))
  ),
  CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
  TestConsole.layer,
  cliConfig
);

/** Environment variables for a test `ConfigProvider`. */
type Environment = Readonly<Record<string, string | undefined>>;

const withEnvironment = (environment: Environment) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(environment)
  );

/**
 * Parse `args` as `kanshi <args>`: the parsed sync flags, if it ran. Needs
 * `CliTestLayer`.
 */
const parse = (args: readonly string[], environment: Environment = {}) =>
  Effect.gen(function* parseEffect() {
    const seen: SyncArgs[] = [];
    const kanshi = makeKanshi((parsed) =>
      Effect.sync(() => {
        seen.push(parsed);
      })
    );
    yield* Command.runWith(kanshi, { version })(args);
    return seen;
  }).pipe(withEnvironment(environment));

const output = Effect.gen(function* outputEffect() {
  const logs = yield* TestConsole.logLines;
  const errors = yield* TestConsole.errorLines;
  return { errors: errors.join("\n"), logs: logs.join("\n") };
});

describe("kanshi arguments", () => {
  it.effect("parses every sync flag", () =>
    Effect.gen(function* allFlags() {
      const seen = yield* parse([
        "sync",
        "--url",
        "https://kanshi.example.com",
        "--config",
        "kanshi.dev.config.ts",
        "--dry-run",
        "--adopt",
        "--wait",
        "30",
      ]);
      assert.deepStrictEqual(seen, [
        {
          adopt: true,
          baseUrl: "https://kanshi.example.com",
          config: "kanshi.dev.config.ts",
          dryRun: true,
          waitSeconds: 30,
        },
      ]);
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.effect("parses the pnpm seed command line", () =>
    Effect.gen(function* seed() {
      const seen = yield* parse(
        "sync --config kanshi.dev.config.ts --url http://localhost:1337 --adopt --wait 30".split(
          " "
        )
      );
      assert.deepStrictEqual(seen, [
        {
          adopt: true,
          baseUrl: "http://localhost:1337",
          config: "kanshi.dev.config.ts",
          dryRun: false,
          waitSeconds: 30,
        },
      ]);
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.effect("applies the defaults", () =>
    Effect.gen(function* defaults() {
      const seen = yield* parse(["sync", "--url", "https://k.example.com"]);
      assert.deepStrictEqual(seen, [
        {
          adopt: false,
          baseUrl: "https://k.example.com",
          config: "kanshi.config.ts",
          dryRun: false,
          waitSeconds: 0,
        },
      ]);
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.effect("falls back to KANSHI_URL, and --url wins over it", () =>
    Effect.gen(function* fallback() {
      const environment = { KANSHI_URL: "https://from-env.example.com" };
      const fromEnv = yield* parse(["sync"], environment);
      assert.strictEqual(fromEnv[0]?.baseUrl, "https://from-env.example.com");
      const fromFlag = yield* parse(
        ["sync", "--url", "https://flag.example.com"],
        environment
      );
      assert.strictEqual(fromFlag[0]?.baseUrl, "https://flag.example.com");
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.effect("requires a URL when KANSHI_URL is unset or blank", () =>
    Effect.gen(function* missingUrl() {
      for (const environment of [{}, { KANSHI_URL: "" }]) {
        const error = yield* parse(["sync"], environment).pipe(Effect.flip);
        assert.instanceOf(error, CliError.ShowHelp);
        const [problem] = error.errors;
        assert.instanceOf(problem, CliError.MissingOption);
        assert.strictEqual(problem.option, "url");
      }
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.effect("rejects a negative or non-numeric --wait", () =>
    Effect.gen(function* badWait() {
      for (const wait of ["-1", "soon", "1.5"]) {
        const error = yield* parse([
          "sync",
          "--url",
          "https://k.example.com",
          "--wait",
          wait,
        ]).pipe(Effect.flip);
        assert.instanceOf(error, CliError.ShowHelp);
        assert.isAbove(error.errors.length, 0);
      }
    }).pipe(Effect.provide(CliTestLayer))
  );

  it.effect("prints help for sync with every flag", () =>
    Effect.gen(function* help() {
      const seen = yield* parse(["sync", "--help"]);
      assert.deepStrictEqual(seen, []);
      const { logs } = yield* output;
      for (const flag of [
        "--url",
        "--config",
        "--dry-run",
        "--adopt",
        "--wait",
        "--help",
        "--version",
      ]) {
        assert.include(logs, flag);
      }
      assert.notInclude(logs, "--wizard");
      assert.notInclude(logs, "--log-level");
    }).pipe(Effect.provide(CliTestLayer))
  );
});

describe("kanshi settings", () => {
  it.effect("reads KANSHI_API_TOKEN as a redacted value", () =>
    Effect.gen(function* token() {
      const value = yield* apiToken.pipe(
        withEnvironment({ KANSHI_API_TOKEN: "secret-token" })
      );
      assert.strictEqual(Redacted.value(value), "secret-token");
      assert.notInclude(String(value), "secret-token");
    })
  );

  it.effect("fails clearly when KANSHI_API_TOKEN is unset or blank", () =>
    Effect.gen(function* missingToken() {
      for (const environment of [{}, { KANSHI_API_TOKEN: "" }]) {
        const error = yield* apiToken.pipe(
          withEnvironment(environment),
          Effect.flip
        );
        assert.instanceOf(error, SyncError);
        assert.strictEqual(
          error.message,
          "KANSHI_API_TOKEN is not set (add it to .env or the environment)"
        );
      }
    })
  );

  it.effect(
    "reports sync failures as user errors, printed without a stack",
    () =>
      Effect.gen(function* userError() {
        const kanshi = makeKanshi(runSync);
        const error = yield* Command.runWith(kanshi, { version })([
          "sync",
          "--url",
          "https://k.example.com",
        ]).pipe(
          withEnvironment({}),
          Effect.provide([CliTestLayer, FetchHttpClient.layer]),
          Effect.flip
        );
        assert.instanceOf(error, CliError.UserError);
        assert.strictEqual(
          error.message,
          "KANSHI_API_TOKEN is not set (add it to .env or the environment)"
        );
      })
  );

  it.effect("reads env() channel URLs through Config", () =>
    Effect.gen(function* channelEnv() {
      const config = {
        channels: [
          {
            key: "hook",
            kind: "webhook" as const,
            name: "Hook",
            url: env("KANSHI_HOOK_URL"),
          },
        ],
      };
      const found = yield* resolveDesired(config).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: { KANSHI_HOOK_URL: "https://hooks.example.com/a" },
          })
        )
      );
      assert.deepStrictEqual(found.errors, []);
      assert.strictEqual(
        found.desired.channels[0]?.url,
        "https://hooks.example.com/a"
      );

      for (const environment of [{}, { KANSHI_HOOK_URL: "   " }]) {
        const missing = yield* resolveDesired(config).pipe(
          withEnvironment(environment)
        );
        assert.deepStrictEqual(missing.errors, [
          'channel "hook": environment variable KANSHI_HOOK_URL is not set',
        ]);
      }
    })
  );
});
