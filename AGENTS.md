# AGENTS.md

Kanshi is a self-hosted uptime monitor: one Cloudflare Worker (Effect v4 +
Alchemy v2) hosting two Durable Objects, plus a React SPA. Usage in
`README.md`, design in `docs/rework-plan.md`, decisions and gotchas per
phase in `docs/rework-notes.md`.

## Layout

- `src/worker.ts`: the Worker; serves `web/dist`, runs first for `/api/*` and `/_dev/*`, the watchdog cron.
- `src/monitor/`: the Monitor DO (one per monitor), its pure rules and storage.
- `src/registry/`: the Registry DO (singleton): monitors, channels, watchdog episodes.
- `src/domain/`, `src/alerts/`: shared schemas and pure rules; alert messages and delivery.
- `src/service/`: operations shared by the API, each a `Context.Service` with a `layer`.
- `src/api/`: the `HttpApi` spec, auth and handlers.
- `web/`: the SPA (Vite, React 19, StyleX, TanStack Router and Query).
- `src/watchdog/`: the cron's rules and runner. `src/dev/`: `/_dev/*` (dev stage only).
- `alchemy.run.ts`: the stack (stage `dev` = dev mode, `prod` for deploys);
  per-stage policy (Worker name `kanshi`, Cloudflare vs `.alchemy/` state) in `src/stages.ts`.
- `test/unit/` (vitest), `test/integ/` (bun + alchemy, own stack); component tests sit next to components.

## Gotchas

- DO schema changes are new `SqliteMigrator` entries; never edit an applied one.
- No `fetch` or cross-DO RPC inside a SQL transaction.
- `src/api/spec.ts` and everything it imports is bundled into the SPA: keep it
  browser-safe (no Worker, DO, Node or Bun imports; `tsc -p web` checks it).
- `web/src/pages/` export components only (Fast Refresh); routes, guards and
  loaders live in `web/src/router.tsx`; reads and writes go through
  `web/src/api/queries.ts`.
- Styles: `stylex.create` with the tokens in `web/src/theme/tokens.stylex.ts`
  only. Check new pages at 390px and desktop, light and dark, and keyboard/a11y.

## Checks

Run before committing (`pnpm fix` formats and applies safe lint fixes):

```sh
pnpm typecheck && pnpm check && pnpm test
pnpm test:integ   # local stack on port 1337, ~4 min; stop `pnpm dev` first
```

## Lint

Fix the code, don't disable rules; the overrides and their reasons are in
`oxlint.config.ts`. The non-obvious Effect conventions (details in
`docs/rework-notes.md`, "Lint conventions"):

- Tagged unions via `Data.taggedEnum` (`T.X()`, `T.$is`, `T.$match`); no `_tag` literals or comparisons.
- Services are a `Context.Service` with a static `layer`; `make*` constructors stay private (exported for tests only).
- Decode with Schema instead of `as`, `JSON.parse` or `typeof`; an unavoidable `as` needs a `// SAFETY:` comment.
- Data-first Effect calls use the pipe form: `xs.pipe(Effect.forEach(f))`.

## Local dev and credentials

- `pnpm dev` sets placeholder Cloudflare credentials in the script itself;
  never put them in `.env`, or `alchemy deploy` uses them too. `.env` holds
  `KANSHI_API_TOKEN`.
- Deploy with `pnpm run deploy` (`pnpm deploy` is pnpm's own command).

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect/LLMS.md` first and inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy/` for examples of idiomatic usage, tests, module structure, and API design.
