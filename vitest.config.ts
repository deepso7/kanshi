// Two projects: `unit` (the Worker's pure rules, Node) and `web` (the
// SPA's components in happy-dom). The web project runs the same StyleX
// and React plugins as `web/vite.config.ts`, so `stylex.create` is
// compiled (it throws when called uncompiled) and class names are real.
import { unplugin as stylex } from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * The StyleX transform without its dev-server hook: that hook starts a
 * CSS-update interval cleared only when an HTTP server closes, and vitest
 * has none, so the run would hang on exit. Tests need no CSS.
 */
const stylexTransform = (): Plugin => {
  const plugin: Plugin = stylex.vite({ useCSSLayers: true });
  return { ...plugin, configureServer: undefined };
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          include: ["test/unit/**/*.test.ts"],
          name: "unit",
        },
      },
      {
        plugins: [stylexTransform(), react()],
        test: {
          environment: "happy-dom",
          include: ["web/src/**/*.test.{ts,tsx}"],
          name: "web",
          setupFiles: ["web/src/test/setup.ts"],
        },
      },
    ],
  },
});
