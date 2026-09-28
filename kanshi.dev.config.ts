// The dev stack's config, applied by `pnpm seed` (`kanshi sync` against
// http://localhost:1337 with --adopt, so resources created by older seeds
// are taken over). Monitors probe the dev stage's own `/_dev/target`
// fixtures; channels post to its `/_dev/webhook` sink (recorded in
// `GET /_dev/events` and printed to the console). Monitors use every
// channel by default.
import { defineConfig } from "./src/config.ts";

const dev = "http://localhost:1337/_dev";

export default defineConfig({
  channels: [
    {
      key: "dev-webhook",
      kind: "webhook",
      name: "Dev webhook sink (generic JSON)",
      url: `${dev}/webhook?as=webhook`,
    },
    {
      key: "dev-slack",
      kind: "slack",
      name: "Dev webhook sink (Slack format)",
      url: `${dev}/webhook?as=slack`,
    },
  ],
  monitors: [
    {
      intervalSeconds: 10,
      key: "dev-ok",
      name: "Always up",
      public: true,
      url: `${dev}/target`,
    },
    {
      intervalSeconds: 10,
      key: "dev-flip",
      name: "Flip target (POST /_dev/target/flip/demo to toggle)",
      public: true,
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
