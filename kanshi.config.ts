// Example config for `pnpm kanshi sync --url https://<your-worker>`.
// Resources are matched by `key`: renaming a key deletes the old resource
// and creates a new one. Sync only touches what it created (managed);
// monitors and channels added in the dashboard are left alone. Channel
// URLs are secrets, so read them from the environment with env("NAME").
import { defineConfig, env } from "./src/config.ts";

export default defineConfig({
  channels: [
    {
      key: "ops-slack",
      kind: "slack",
      name: "#ops on Slack",
      url: env("KANSHI_SLACK_WEBHOOK_URL"),
    },
    {
      key: "phone",
      kind: "ntfy",
      name: "ntfy push",
      url: env("KANSHI_NTFY_URL"),
    },
  ],
  monitors: [
    {
      key: "website",
      name: "Website",
      public: true,
      url: "https://example.com",
    },
    {
      bodyContains: "ok",
      channels: ["ops-slack", "phone"],
      expectedStatus: 200,
      failureThreshold: 2,
      intervalSeconds: 30,
      key: "api-health",
      name: "API health",
      public: true,
      timeoutMs: 5000,
      url: "https://api.example.com/health",
    },
    {
      channels: ["ops-slack"],
      enabled: false,
      intervalSeconds: 300,
      key: "staging",
      method: "HEAD",
      name: "Staging (paused)",
      url: "https://staging.example.com",
    },
  ],
});
