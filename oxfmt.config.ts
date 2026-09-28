import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Vendored agent skills are managed by skills-lock.json; leave them as-is.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), ".agents/**"],
  // Keep hand-wrapped Markdown docs as written.
  proseWrap: "preserve",
});
