import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest, react, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "lint/anti-slop/**"],
  // The Effect rule group of dmmulroy/anti-slop, vendored in lint/anti-slop
  // (ultracite's anti-slop preset only bundles the generic rules).
  jsPlugins: [
    { name: "anti-slop-effect", specifier: "./lint/anti-slop/effect/index.ts" },
  ],
  rules: {
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
});
