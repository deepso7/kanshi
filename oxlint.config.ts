import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  rules: {
    // TypeScript already rejects real redeclarations; this rule flags the
    // idiomatic `const X = Schema...; type X = typeof X.Type` pairs.
    "no-redeclare": "off",
    // Flags `Effect.forEach(items, f)` as `Array#forEach` with a thisArg.
    "unicorn/no-array-for-each": "off",
    "unicorn/no-array-method-this-argument": "off",
    // Flags `Schema.TaggedError<X>()(...)` class factories as `throw Error()`.
    "unicorn/throw-new-error": "off",
  },
});
