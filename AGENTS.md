# AGENTS.md

Kanshi is a self-hosted uptime monitor: one Cloudflare Worker (Effect v4 +
Alchemy v2) hosting two Durable Object classes. See `README.md` for usage,
`docs/rework-plan.md` for the design and `docs/rework-notes.md` for
decisions, deviations and gotchas per phase.

## Layout

- `src/worker.ts`: the Worker. Serves the SPA (`web/dist`) as static
  assets; runs first for `/api/*` (Effect `HttpApi`) and `/_dev/*` (dev
  stage only; `src/http/worker-paths.ts` lists them, shared with the Vite
  proxy), 404 for anything else that reaches it; registers the watchdog
  cron; provides both DOs.
- `src/monitor/`: the **Monitor DO** (`monitor.ts`, one object per monitor,
  named by monitor id) and its pure rules (`machine.ts`, `cycle.ts`,
  `reset.ts`, `outbox.ts`, `history.ts`) and storage/migrations
  (`storage.ts`).
- `src/registry/`: the **Registry DO** (`registry.ts`, singleton named
  `registry`): monitor lifecycle, `public`/`managed` flags, cached
  summaries, channels, watchdog episodes and outbox (`watchdog-store.ts`).
- `src/domain/`: shared schemas and pure rules (inputs, URLs, expected
  status, probe, channels). `src/alerts/`: messages and delivery.
- `src/service/`: operations shared by the API and the dashboard, each a
  `Context.Service` with a static `layer`. `src/api/`: `HttpApi` spec,
  auth and thin handler layers. `src/api/spec.ts` and everything it imports
  (`middleware.ts`, `src/domain/`, `src/auth/session.ts`) is also bundled
  into the SPA: keep it browser-safe (no Worker, DO, Node or Bun imports;
  `tsc -p web` checks it against the DOM). `src/auth/session.ts`: the
  session cookie (HMAC) and the Origin check. `src/settings.ts`: `KanshiSettings`, the
  Worker's config (API token, dev mode, quota).
- `web/`: the SPA (Vite, React 19, StyleX, TanStack Router and Query), its
  own `tsconfig.json`. `web/src/api/`: the typed client (`HttpApiClient`
  from the spec), query and mutation options (`queries.ts`) and error
  views (`errors.ts`); `web/src/pages/` (components only, for Fast
  Refresh); `web/src/router.tsx` (the route tree, session guard, loaders,
  the 401 sign-out); `web/src/lib/` (formatting, `useToastMutation`,
  `useNow`); `web/src/components/` (design system in `ui/`, app pieces);
  `web/src/theme/tokens.stylex.ts` (design tokens). `web/public/_headers`:
  CSP and caching for the static assets.
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
pnpm test:integ   # builds web/, local stack on port 1337, ~4 min; stop `pnpm dev` first
```

`pnpm fix` applies formatting and safe lint fixes.

## Lint conventions

`pnpm check` runs oxlint (`oxlint.config.ts`: ultracite core, vitest,
react and anti-slop presets plus the vendored Effect rules in
`lint/anti-slop/`). Fix the code; do not add `oxlint-disable` comments for
the rules below.

- `no-manual-tagged-construction`: never write `{ _tag: "X", ... }`. Model
  plain tagged unions as `type T = Data.TaggedEnum<{ X: {...}; Y:
Record<never, never> }>` plus `const T = Data.taggedEnum<T>()`, and build
  with `T.X({...})` / `T.Y()`. Errors are `Schema.TaggedError` classes
  (`new E({...})`); schema-backed values use `Schema.TaggedStruct(...).make`
  or `Schema.TaggedClass`. Shared ones: `DeliveryResult`
  (`src/alerts/delivery.ts`), `AlertMessage` (plus
  `incidentMessage`/`watchdogMessage` for a runtime tag,
  `src/alerts/message.ts`).
- `no-manual-tag-comparison` / `prefer-effect-match`: no `x._tag === "X"`
  or `switch (x._tag)`. Exhaustive branching: `T.$match(x, {...})` for a
  `taggedEnum`, else `Match.valueTags(x, {...})`; partial:
  `Match.value(x).pipe(Match.tag("A", "B", f), Match.orElse(g))`. One tag:
  `T.$is("X")(x)` or `Predicate.isTagged(x, "X")`. Effect's own data types
  have guards: `Result.isFailure`, `Exit.isSuccess`, `Option.isSome`.
  Chained literal ternaries on one value become `Match.value(v).pipe(
Match.when(...), ...)`.
- `no-manual-effect-error-tag`: in `Effect.catch`/`catchIf` use
  `Effect.catchTag(s)`, or `Effect.catchReason("Err", "Reason", f)` for a
  tagged `reason`.
- `no-service-constructor-imports` (no project-local `make[A-Z]*` import
  outside tests): a dependency-bearing constructor stays private to its
  module, which exports a `Context.Service` class with a static `layer`
  that yields its dependencies (`KanshiSettings`, `Monitor`, `Registry`,
  other services); consumers `yield*` the service and the Worker provides
  the layers. `make*` stays exported only for tests. A plain helper that is
  not a service is renamed (e.g. `createX`).
- `no-redeclare`: off (see overrides); keep Effect's
  `const X = Schema...; type X = typeof X.Type` pairing.
- `require-safety-comment-for-type-assertion`: first try to drop the `as`
  (decode with Schema, `satisfies`, a type guard, a precise signature).
  Otherwise put `// SAFETY: <the checked invariant that makes it true>` on
  the line(s) right before the assertion or its statement/property.
- `no-chained-type-assertions`: no `as unknown as T`; build a value that
  really has type `T` (a typed test double, `satisfies`), or decode it.
- `no-runtime-typeof`: decode external input with Schema at the boundary
  (`Schema.decodeUnknown*`, `Schema.fromJsonString(S)` instead of
  `JSON.parse`); for small local checks use `Predicate.isString` etc.
  `typeof` is allowed only inside a `(x): x is T` type guard.
- `no-unknown-parameters`: take a named domain type (or `Schema.Json`). A
  thrown value from `try`/`catch`/`Effect.try*` is named `cause: unknown`
  (the rule's one exemption).
- `no-unsafe-dictionary-type`: no `Record<string, unknown>`; decode into a
  Schema `Struct`/`Record` of concrete values, or use `Schema.Json`.
- `no-known-value-widening`: no inline object/`Record<string, X>`
  annotations on literals or returns. Let inference work, use `satisfies`,
  a closed key union (`Record<Key, string>`), a `Map`, or a named
  `interface` for a function's return type.
- `no-conditional-empty-object-spread`: no `...(c ? {} : { k })`. Build the
  object, then `if (c) { obj.k = v }` on a mutable local, or give the
  field an explicit `undefined`/`null` where the type allows it.
- `unicorn/no-array-method-this-argument`: fires on data-first Effect
  calls with two arguments (`Effect.map(fx, f)`, `Effect.forEach(xs, f)`);
  use the pipe form `fx.pipe(Effect.map(f))` / `pipe(xs, Effect.forEach(f))`.
- `vitest/prefer-describe-function-title`: when a `describe` title is the
  name of an imported function, pass the function: `describe(probe, ...)`.
- `vitest/prefer-importing-vitest-globals`: unit tests import from
  `@effect/vitest`/`vitest`; off for `test/integ` (see overrides).

Overrides in `oxlint.config.ts`, each a false positive on idiomatic code:

- `no-redeclare` off: oxlint has no `ignoreDeclarationMerge`, so it flags
  Effect's value/type pair `const X`/`type X`; tsc reports real
  redeclarations.
- `unicorn/no-array-for-each` off: it matches every `Effect.forEach` by
  method name, in any call form.
- `unicorn/throw-new-error` off: it matches the class factory call in
  `extends Schema.TaggedError<X>()("X", ...)`.
- `vitest/prefer-importing-vitest-globals` off in `test/integ/**`: that
  suite runs on `bun test` and imports `expect` from `bun:test`.

## Local dev and credentials

- `pnpm dev` runs `alchemy dev --stage dev` offline with **placeholder**
  `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` set in the script. Never put
  those placeholders in `.env`: `alchemy deploy` would use them too. The
  stack also starts the SPA's Vite dev server (`Command.Dev`, HMR) on
  http://localhost:5173; it proxies the Worker's paths to port 1337.
- Deploy with `pnpm run deploy` (`pnpm deploy` is pnpm's own command).
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
