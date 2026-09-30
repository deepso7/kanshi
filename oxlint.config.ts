import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

const clockMessage =
  "Use Clock.currentTimeMillis or DateTime (DateTime.now, DateTime.make).";
const timersMessage = "Use Effect.sleep, Effect.delay or Schedule.";
const configMessage = "Use Config.";

// Banned in src/ (see the override below), each naming the Effect way.
const effectNativeGlobals = [
  { message: clockMessage, name: "Date" },
  { message: "Use HttpClient (src/http/client.ts).", name: "fetch" },
  ...["setTimeout", "setInterval", "queueMicrotask"].map((name) => ({
    message: timersMessage,
    name,
  })),
  { message: "Use Effect.log* or Console.", name: "console" },
];

const effectNativeProperties = [
  ...["parse", "stringify"].map((property) => ({
    message: "Use Schema.fromJsonString (or Schema.UnknownFromJsonString).",
    object: "JSON",
    property,
  })),
  { message: "Use Random.", object: "Math", property: "random" },
  { message: configMessage, object: "process", property: "env" },
  ...["all", "allSettled", "any", "race", "reject", "resolve"].map(
    (property) => ({
      message:
        "Use Effect.all, Effect.race, Effect.succeed or Effect.fail; Effect.tryPromise at a promise boundary.",
      object: "Promise",
      property,
    })
  ),
  // `globalThis.x` sidesteps no-restricted-globals.
  ...[
    ["fetch", "Use HttpClient (src/http/client.ts)."],
    ["setTimeout", timersMessage],
    ["setInterval", timersMessage],
    ["queueMicrotask", timersMessage],
  ].map(([property, message]) => ({ message, object: "globalThis", property })),
];

// Every rule override below carries its reason: each is a false positive
// on idiomatic Effect or bun code. Fix the code rather than add more.
export default defineConfig({
  extends: [core, vitest, react, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "lint/anti-slop/**"],
  // The Effect rule group of dmmulroy/anti-slop, vendored in lint/anti-slop
  // (ultracite's anti-slop preset only bundles the generic rules).
  jsPlugins: [
    { name: "anti-slop-effect", specifier: "./lint/anti-slop/effect/index.ts" },
    { name: "effect-native", specifier: "./lint/effect-native/index.ts" },
  ],
  overrides: [
    {
      // src/ is Effect-native: the Worker and DOs use Effect's clock,
      // HTTP client, scheduler, errors, JSON codecs, logger and config.
      // Oxlint has no `no-restricted-syntax`, so statements and keywords
      // (async/await, new Promise and chaining, try, throw) come from the
      // local `effect-native` plugin. web/ is promise-based React.
      excludeFiles: ["**/*.test.ts"],
      files: ["src/**/*.ts"],
      rules: {
        "effect-native/no-async": "error",
        "effect-native/no-promise": "error",
        "effect-native/no-throw": "error",
        "effect-native/no-try": "error",
        "no-restricted-globals": ["error", ...effectNativeGlobals],
        "no-restricted-imports": [
          "error",
          {
            paths: [
              ...[
                "timers",
                "timers/promises",
                "node:timers",
                "node:timers/promises",
              ].map((name) => ({ message: timersMessage, name })),
              ...["process", "node:process"].map((name) => ({
                importNames: ["env"],
                message: configMessage,
                name,
              })),
            ],
          },
        ],
        "no-restricted-properties": ["error", ...effectNativeProperties],
      },
    },
    {
      // The integration suite runs on `bun test` and imports `expect` from
      // `bun:test`; the rule only accepts imports from `vitest`.
      files: ["test/integ/**/*.test.ts"],
      plugins: ["vitest"],
      rules: {
        "vitest/prefer-importing-vitest-globals": "off",
      },
    },
  ],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
    // Oxlint's no-redeclare has no `ignoreDeclarationMerge` option, so it
    // flags Effect's `const X = Schema...; type X = typeof X.Type` pair (a
    // value and a type, which TypeScript keeps apart). tsc already reports
    // real redeclarations (TS2451/TS2300).
    "no-redeclare": "off",
    // Matches every `Effect.forEach(...)` by method name alone; neither the
    // data-first nor the data-last form avoids it.
    "unicorn/no-array-for-each": "off",
    // Matches the heritage clause `Schema.TaggedError<X>()("X", ...)` by
    // callee name: that call is a class factory, not an error construction.
    "unicorn/throw-new-error": "off",
  },
});
