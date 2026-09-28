# Kanshi rework notes

## Phase 0

### Versions

- `effect`, `@effect/platform-node`, `@effect/platform-bun`, `@effect/vitest`,
  `@effect/sql-d1`, `@effect/sql-pg`: `4.0.0-rc.117`, pinned for transitive
  deps too via `overrides` in `pnpm-workspace.yaml`.
  - **Not rc.118.** rc.118 moved `effect/unstable/*` to `effect/*` and
    removed the old paths, but `alchemy@2.0.0-beta.79` (and alchemy `main`)
    still imports `effect/unstable/*`, so it breaks at load time. Move to
    rc.118+ (and `effect/http`, `effect/http-api`, ...) when an alchemy
    release adopts it.
- `alchemy`: `2.0.0-beta.79` (peer `effect >=4.0.0-rc.115`).
- `vitest` `5.0.2`, `@cloudflare/workers-types` `5.20260928.1`,
  `@types/bun` `1.4.2`, `@types/node` `26.6.3`, `oxlint` `1.86.0`,
  `oxfmt` `0.71.0`, `ultracite` `7.12.1`, `@effect/language-service`
  `0.87.3`. `typescript` is already the latest (`7.0.2`).
- `drizzle-orm` / `drizzle-kit`: `1.0.0-rc.5-ab785fc`, alchemy's peer
  version. Bumped only because `1.0.0-rc.4` calls the removed
  `Schema.TaggedErrorClass`. `@tinybirdco/sdk` is unchanged.
- Vendored clones: `.repos/effect` at `effect@4.0.0-rc.117`,
  `.repos/alchemy` at `v2.0.0-beta.79`.

### Integration tests

`pnpm test:integ` deploys the real stack to Cloudflare (stage `test`). It
bundles and starts, then fails on auth: alchemy beta.79 needs a Cloudflare
OAuth profile that includes scopes. Run
`alchemy profile refresh --profile default --provider Cloudflare`
interactively, then run the tests again.

### `@effect/sql-sqlite-do`

Recommendation: **use it** for the Monitor and Registry DOs instead of raw
`storage.sql.exec`.

- It is published in lockstep with effect (`4.0.0-rc.117`) and is already a
  transitive dependency of alchemy. Add it as a direct dependency.
- Wire it the same way alchemy's `Drizzle.DurableObject` does
  (`.repos/alchemy/packages/alchemy/src/Drizzle/Cloudflare.ts`). In the DO
  instance effect, get `DurableObjectState`, then run
  `Layer.build(SqliteClient.layer({ storage: state.raw.storage }))`.
  Alchemy's wrapped `storage.sql` exposes the raw binding as
  `storage.sql.raw` / `state.raw.storage`.
- What it provides: the `sql` tagged template with bound params, a typed
  `SqlError`, `SqlSchema` for Schema-decoded rows, and `SqliteMigrator` to
  replace a hand-rolled `schema_version`. `withTransaction` runs on
  `storage.transaction()` and rolls back on failure or interruption, which
  covers the plan's "state change + notification row in one transaction".
- Caveats:
  - A transaction holds the input gate and a client semaphore, so it must
    not contain `fetch` or cross-DO RPC. The plan already forbids that.
  - Concurrent sibling transactions are unsupported.
  - `updateValues` is unsupported.
  - Alarms are still set through alchemy's `storage.setAlarm`.
