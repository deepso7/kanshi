# AGENTS.md

Kanshi is a self-hosted uptime monitor: one Cloudflare Worker (Effect v4 +
Alchemy v2) hosting two Durable Object classes. See `README.md` for usage,
`docs/rework-plan.md` for the design and `docs/rework-notes.md` for
decisions, deviations and gotchas per phase.

## Layout

- `src/worker.ts`: the Worker. Routes `/api/*` (Effect `HttpApi`), `/_dev/*`
  (dev stage only) and pages; registers the watchdog cron; provides both DOs.
- `src/monitor/`: the **Monitor DO** (`monitor.ts`, one object per monitor,
  named by monitor id) and its pure rules (`machine.ts`, `cycle.ts`,
  `reset.ts`, `outbox.ts`, `history.ts`) and storage/migrations
  (`storage.ts`).
- `src/registry/`: the **Registry DO** (`registry.ts`, singleton named
  `registry`): monitor lifecycle, `public`/`managed` flags, cached
  summaries, channels, watchdog episodes and outbox (`watchdog-store.ts`).
- `src/domain/`: shared schemas and pure rules (inputs, URLs, expected
  status, probe, channels). `src/alerts/`: messages and delivery.
- `src/service/`: operations shared by the API and the dashboard.
  `src/api/`: `HttpApi` spec, auth and thin handlers.
- `src/ui/`: server-rendered dashboard and status page (no build step).
- `src/watchdog/`: the cron's rules and runner. `src/dev/`: `/_dev/*`.
- `src/config.ts`: `defineConfig` for `kanshi.config.ts` /
  `kanshi.dev.config.ts`. `src/sync/`: `kanshi sync` (`plan.ts` is the pure
  diff). `scripts/kanshi.ts`: the CLI.
- `alchemy.run.ts`: the stack (stage `dev` enables dev mode, `prod` for
  deploys). `test/unit/` (vitest), `test/integ/` (bun + alchemy test
  harness, its own stack in `test/integ/alchemy.run.ts`).

Durable Object schema changes are new `SqliteMigrator` entries (`"<n>_name"`)
in `src/monitor/storage.ts` or `src/registry/`; never edit an applied one.
Keep `fetch` and cross-DO RPC out of SQL transactions.

## Checks

Run all of these before committing:

```sh
pnpm typecheck && pnpm check && pnpm test
pnpm test:integ   # local stack on port 1337, ~4 min; stop `pnpm dev` first
```

`pnpm fix` applies formatting and safe lint fixes.

## Local dev and credentials

- `pnpm dev` runs `alchemy dev --stage dev` offline with **placeholder**
  `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` set in the script. Never put
  those placeholders in `.env`: `alchemy deploy` would use them too.
- `.env` holds `KANSHI_API_TOKEN` (the API token and dashboard password).
  `pnpm seed` syncs `kanshi.dev.config.ts` to the dev stack.
- Integration tests use their own token (`test/integ/alchemy.run.ts`).

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect/LLMS.md` first and inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy/` for examples of idiomatic usage, tests, module structure, and API design.
