// Monitors created by `pnpm seed` against the local dev stack (`pnpm dev`).
// They probe the dev stage's own `/_dev/target` fixtures.
import { defineConfig } from "./src/config.ts";

const dev = "http://localhost:1337/_dev";

export default defineConfig({
  monitors: [
    {
      intervalSeconds: 10,
      key: "dev-ok",
      name: "Always up",
      url: `${dev}/target`,
    },
    {
      intervalSeconds: 10,
      key: "dev-flip",
      name: "Flip target (POST /_dev/target/flip/demo to toggle)",
      url: `${dev}/target/flip/demo`,
    },
    {
      bodyContains: "healthy",
      intervalSeconds: 15,
      key: "dev-slow",
      name: "Slow target with keyword",
      timeoutMs: 5000,
      url: `${dev}/target?delay=1500&body=healthy`,
    },
  ],
});
