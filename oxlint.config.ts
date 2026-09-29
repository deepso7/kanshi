import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";
import react from "ultracite/oxlint/react";
import antiSlop from "ultracite/oxlint/anti-slop";

export default defineConfig({
  extends: [core, vitest, react, antiSlop],
  ignorePatterns: core.ignorePatterns,
});
