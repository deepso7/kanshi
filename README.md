# Kanshi

A small, self-hosted uptime monitor that runs as **one Cloudflare Worker**
with **one secret**. Each monitor is a Durable Object that checks its URL on
its own alarm, keeps its history and incidents in its own SQLite storage and
sends alerts to Slack, Discord, ntfy or any webhook. You get a dashboard, a
public status page, a JSON API and config-as-code.

- HTTP(S) checks: method, expected status (`200`, `2xx`, `200,204`), body
  keyword, timeout, interval (30s minimum), failure/success thresholds. A
  failure is confirmed by a second probe 5 seconds later before it counts.
- 90-day uptime bars, latency, incidents and alert delivery log per monitor.
- Alerts are at-least-once, retried with backoff, and a channel never gets a
  "recovered" without the matching "down".
- A watchdog cron (hourly) repairs lost alarms and alerts when a monitor is
  not being checked. Checks only talk to the shared Registry object when
  a monitor's status or settings change, so a quiet install costs about
  one Durable Object request per check.

## Setup

You need Node, pnpm, [Bun](https://bun.sh) and a Cloudflare account.

1. **Install and deploy.**

   ```sh
   pnpm install
   cp .env.example .env   # set KANSHI_API_TOKEN, e.g. `openssl rand -hex 32`
   pnpm run deploy        # builds the UI, alchemy deploy --stage prod; prints the Worker URL
   ```

   Alchemy authenticates with a Cloudflare profile (manage it with
   `pnpm exec alchemy profile`) or with `CLOUDFLARE_ACCOUNT_ID` /
   `CLOUDFLARE_API_TOKEN` from the environment. The token is deployed as
   a Worker secret. Deployment state lives in `.alchemy/`; keep it on the
   machine you deploy from. `pnpm run destroy` removes everything. (Use
   `pnpm run deploy`: plain `pnpm deploy` is pnpm's own command.)

2. **Open the dashboard** at the Worker URL and sign in with the token. The
   public status page is at `/status`.

3. **Add monitors and channels**, in the dashboard or as code:

   ```sh
   pnpm kanshi sync --url https://<your-worker> --dry-run   # show the plan
   pnpm kanshi sync --url https://<your-worker>             # apply it
   ```

## Config as code

`kanshi.config.ts` (see the example in this repo):

```ts
import { defineConfig, env } from "./src/config.ts";

export default defineConfig({
  channels: [
    {
      key: "ops",
      kind: "slack",
      name: "#ops",
      url: env("KANSHI_SLACK_WEBHOOK_URL"),
    },
  ],
  monitors: [
    {
      key: "api",
      name: "API",
      url: "https://api.example.com/health",
      channels: ["ops"],
      public: true,
    },
  ],
});
```

`pnpm kanshi sync [--url <base>] [--config <path>] [--dry-run] [--adopt]`
(`--url` defaults to `KANSHI_URL`; needs `KANSHI_API_TOKEN`):

- Resources are matched by `key`. Sync creates, updates and deletes only the
  resources it created (`managed`); anything added in the dashboard is left
  alone. A config key that belongs to a dashboard-created resource is an
  error, unless `--adopt` takes it over.
- Fields left out get the defaults, so removing a field resets it. Edits made
  in the dashboard to a managed resource are overwritten by the next sync
  (the dashboard marks those resources "managed by config").
- Channel URLs are secrets: use `env("NAME")`. They are never read back;
  sync compares SHA-256 hashes of the normalised URLs.
- Monitors use every channel (`"all"`, the default) or a list of channel keys.
- The plan is printed first. Config errors abort before any change; a failed
  request stops the run, and running sync again converges.

## Alerts

Channels are global: `slack`, `discord`, `ntfy` (topic URL, `?auth=` token
allowed) and `webhook` (JSON POST with an `Idempotency-Key` header). URLs must
be https. A monitor alerts on "down" (after the confirm and failure
threshold) and on "recovered". Failed deliveries are retried for about an
hour (30s doubling to 30m, 8 attempts); 4xx responses other than
408/425/429 are final. Use "Send test alert" on the channels page or
`POST /api/channels/:id/test` to check a channel.

## API

All routes except `/api/public/*` and `/api/session` need `Authorization:
Bearer $KANSHI_API_TOKEN` (or the dashboard session). Errors are JSON such as
`{ "_tag": "NotFound", "message": "monitor … not found" }` with 400, 404, 409
or 503. A monitor `PATCH` that changed
`public` but could not apply the rest answers 409 (a concurrent edit made it
invalid) or 503 (`Unavailable`); the message says so: retry it.

| Route                                                      | What                                           |
| ---------------------------------------------------------- | ---------------------------------------------- |
| `GET/POST /api/monitors`                                   | list (cached status, no last check), create    |
| `GET/PATCH/DELETE /api/monitors/:id`                       | config and state, edit, delete                 |
| `POST /api/monitors/:id/check`                             | check now                                      |
| `GET /api/monitors/:id/checks?since&limit`                 | raw checks, newest first                       |
| `GET /api/monitors/:id/uptime?days=90`                     | daily uptime and latency                       |
| `GET /api/monitors/:id/incidents?limit`                    | incidents with their alert deliveries          |
| `GET /api/monitors/:id/recent?hours=24&buckets=48`         | recent uptime and latency buckets              |
| `GET /api/overview?hours=24&buckets=48`                    | every monitor, live status, last check, recent |
| `GET /api/watchdog/episodes`                               | open "not being checked" episodes              |
| `GET /api/meta`                                            | dev mode, minimum interval, quota              |
| `GET /api/dev/events?limit=20`                             | dev webhook sink events (dev mode only)        |
| `GET/POST /api/channels`, `PATCH/DELETE /api/channels/:id` | channels (URL write-only: masked + hash)       |
| `POST /api/channels/:id/test`                              | send a test alert                              |
| `GET /api/public/status`                                   | public monitors only, no URLs (no auth)        |
| `GET/POST/DELETE /api/session`                             | dashboard sign-in state, sign in, out          |

## UI

The dashboard (monitors, their history and incidents, channels) and the
public status page are a React app in `web/` (Vite, React 19, StyleX,
TanStack Router and Query, Base UI), with a light and a dark theme. It talks
to the Worker only through the JSON API above, with the typed client
derived from the API's spec.

- **Development:** `pnpm dev` serves it on http://localhost:5173 with hot
  reload; Vite proxies `/api` and `/_dev` to the Worker on port 1337, so
  the page and the API share one origin, as deployed.
- **Production:** `pnpm build` bundles it into `web/dist`, which the
  Worker serves as static assets (every page path gets `index.html`; only
  `/api/*`, and `/_dev/*` in the dev stage, run the Worker code). `pnpm run deploy` builds first, so a deploy
  always ships the current UI.

## Local development

```sh
pnpm dev    # alchemy dev --stage dev, fully offline: open http://localhost:5173
pnpm seed   # kanshi sync of kanshi.dev.config.ts to the dev stack
pnpm build  # build the UI (web/dist), as deploys and integration tests do
```

`pnpm dev` runs the Worker on http://localhost:1337 and the UI's dev server
on http://localhost:5173 (see [UI](#ui)). The Worker on 1337 serves whatever
`web/dist` held when it started; use 5173. Sign-in works on `localhost` in
Chrome and Firefox (the session cookie is `Secure`; Safari may refuse it
over http).

`pnpm dev` needs only `KANSHI_API_TOKEN` in `.env` (it uses placeholder
Cloudflare credentials; no account or network). Durable Object data persists
in `.alchemy/local/` across restarts. The dev stage allows 5-second
intervals and `http://localhost` targets and webhooks, and adds fixtures
(only when run locally by `alchemy dev`, and only for requests to a loopback
host):

- `/_dev/target?status=500&delay=2000&body=...`: a fake target.
- `/_dev/target/flip/:name`: a target that is up or down; `POST
/_dev/target/flip/:name?up=false` flips it.
- `/_dev/webhook?fail=500&failTimes=2`: an alert sink; alerts are printed to
  the console, listed on the dashboard and in `GET /_dev/events`.
- `/_dev/monitors/:id` (raw state, checks, alerts), `/_dev/registry`,
  `/_dev/registry/calls` (Registry calls per method), `POST
/_dev/watchdog`, `POST /_dev/monitors/:id/maintain`.

The seeded monitors watch those fixtures and alert the sink, so flipping
`demo` shows the whole down/alert/recovery cycle within seconds.

## Checks and tests

```sh
pnpm typecheck    # tsc (the Worker, then web/)
pnpm check        # ultracite (oxlint + oxfmt); `pnpm fix` to fix
pnpm test         # unit tests (vitest)
pnpm test:integ   # builds the UI, then integration tests against a local stack (bun, ~4 min)
```

`pnpm test:integ` runs the Worker locally on port 1337 with real alarms; stop
`pnpm dev` first.
