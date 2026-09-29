import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Vendored upstream source; keep it byte-identical for future updates.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "lint/anti-slop/**"],
  // Keep hand-wrapped Markdown docs as written.
  proseWrap: "preserve",
});
