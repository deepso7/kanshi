// The SPA's Vite config (root: `web/`). `pnpm build` writes `web/dist`,
// which the Worker serves as static assets. In dev (`pnpm dev` starts this
// server next to the Worker), the Worker's own paths are proxied to it so
// the SPA and the API share one origin, as in production.
import type { ClientRequest, IncomingMessage } from "node:http";

// Named: the package types are CommonJS, so NodeNext would wrap `default`.
import { unplugin as stylex } from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import type { ProxyOptions } from "vite";
import { defineConfig } from "vite";

import { workerPrefixes } from "../src/http/worker-paths.ts";

/** The local Worker (`alchemy dev`); the stack passes its URL. */
const workerUrl = new URL(
  process.env.KANSHI_WORKER_URL ?? "http://localhost:1337"
);

/**
 * The Worker checks that a cookie-authenticated write comes from its own
 * origin. A request from a page on this dev server carries this server's
 * origin, so it is rewritten to the Worker's; any other Origin is kept
 * (and still refused).
 */
const rewriteOwnOrigin = (
  proxyRequest: ClientRequest,
  request: IncomingMessage
) => {
  const origin = proxyRequest.getHeader("origin");
  if (
    request.headers.host !== undefined &&
    origin === `http://${request.headers.host}`
  ) {
    proxyRequest.setHeader("origin", workerUrl.origin);
  }
};

const toWorker: ProxyOptions = {
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", rewriteOwnOrigin);
  },
  target: workerUrl.origin,
};

export default defineConfig({
  build: {
    // No inline `data:` scripts or styles under the strict CSP.
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        // Libraries every route needs, in their own long-cached chunks: a
        // deploy that only changes the app keeps them. Base UI is left to
        // split with the pages that use each component.
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/u,
            },
            { name: "tanstack", test: /node_modules[\\/]@tanstack[\\/]/u },
            { name: "effect", test: /node_modules[\\/]effect[\\/]/u },
          ],
        },
      },
    },
  },
  plugins: [
    // Before the React plugin, to keep Fast Refresh.
    stylex.vite({ useCSSLayers: true }),
    react(),
  ],
  server: {
    proxy: Object.fromEntries(
      workerPrefixes.map((prefix) => [`^${prefix}(?:/|$)`, toWorker])
    ),
  },
});
