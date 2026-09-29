import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

// Every rule override below is listed, with its reason, under "Lint
// conventions" in AGENTS.md.
export default defineConfig({
  extends: [core, vitest, react, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "lint/anti-slop/**"],
  // The Effect rule group of dmmulroy/anti-slop, vendored in lint/anti-slop
  // (ultracite's anti-slop preset only bundles the generic rules).
  jsPlugins: [
    { name: "anti-slop-effect", specifier: "./lint/anti-slop/effect/index.ts" },
  ],
  overrides: [
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
