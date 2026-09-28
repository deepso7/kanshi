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

## Phase 1 (spike)

The spike (Worker + `Monitor` DO + `Registry` DO) was committed in `af20975`
and `3865c5a` and deleted afterwards; use `git show 3865c5a:spike/monitor.ts`
etc. to see the full code. Everything below was run for real under
`alchemy dev` (local workerd) and the alchemy Bun test harness.

### Verdict: go

| #   | Question                                             | Result                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DO alarms fire locally                               | **Go.** A 3s repeating alarm fired on time (±5 ms). Alarms fire with no incoming request.                                                                                                                                                                                                |
| 2   | SQLite data and pending alarms survive a dev restart | **Go.** Tested with SIGINT (clean stop) and SIGKILL of the CLI and workerd. After restart, rows were intact, a pending alarm fired at its scheduled time, alarms that came due while dev was down fired about 3s after startup, and repeating alarms resumed. Migrations did not re-run. |
| 3   | RPC Worker → two DO classes, and DO → DO             | **Go.** Worker → Monitor, Worker → Registry, and Monitor → Registry (including from inside `alarm`) all work.                                                                                                                                                                            |
| 4   | `@effect/sql-sqlite-do` inside an alchemy DO         | **Go.** Tagged-template queries, `SqlSchema`, `SqliteMigrator` and `withTransaction` (rollback verified) all work.                                                                                                                                                                       |
| 5   | Account id locally / offline                         | **Go, with placeholder env credentials.** No Cloudflare login or network is needed (see below).                                                                                                                                                                                          |

Extra findings:

- **Failed alarms are retried locally.** An alarm that dies is retried with
  backoff (about 2s, then 4s), and `AlarmInvocationInfo.retryCount` is
  passed in (0, 1, 2). Storage writes made before the failure are **not**
  rolled back: a `kv.put` before the injected failure persisted. This fits the
  plan's "idempotent steps, alarm derived from persisted state" design.
- **Integration tests work offline.** `Test.make({ dev: true, ... })` from
  `alchemy/Test/Bun` ran the stack locally with the same placeholder
  credentials, saw the alarm fire twice, and cleaned up (about 6s).
- `Effect.log` inside a DO shows in the `alchemy dev` console, prefixed with
  the worker name. Full logs are in `.alchemy/log/<stage>/<Worker>/`.

### 5. Running `alchemy dev` without Cloudflare credentials

Profile-based auth fails in `precreate` when the OAuth profile needs
`alchemy profile refresh`, even for fully local resources:
`NeedsReauth: Cloudflare OAuth scopes need to be selected`.

The Cloudflare auth provider (`Cloudflare/Auth/AuthProvider.ts`
`readEnvironment`, chosen by `Auth/Resolve.ts` `resolveProviderConfig`)
**prefers environment credentials over the profile whenever they are all
present**, whether or not `CI` is set. It only validates the format: the
account id must be 32 hex characters, and the token can be any non-empty
string. `LocalWorkerProvider` uses the account id only as metadata (worker
attributes, the `ALCHEMY_CLOUDFLARE_ACCOUNT_ID` text binding, remote-binding
config) and never calls the API for local resources. Alchemy's own dev tests
(`examples/dev-stress/test/harness.ts`, `test/Local/DevCliKill.test.ts`) use
the same trick.

```sh
CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 \
CLOUDFLARE_API_TOKEN=local-dev-placeholder \
  alchemy dev --stage dev
# log: "Cloudflare: using environment variables (CLOUDFLARE_ACCOUNT_ID,
#       CLOUDFLARE_API_TOKEN) instead of the profile."
```

`--env-file <file>` with those two lines also works (tested). `CI=1` is not
needed.

Rules for phase 2:

- Put the placeholders **only** in the dev and test commands (the `pnpm dev`
  script, a dev-only env file passed with `--env-file`, or the test
  script's env). **Never** put them in `.env`: `alchemy deploy` also prefers
  env credentials and would use the fake ones.
- `Alchemy.remote()` bindings and any real Cloudflare resource cannot work
  with placeholders. The new design has none, so dev is fully offline.

### Where local state lives (gotchas)

- DO storage is stored in
  `.alchemy/local/<workerPhysicalName>-<ClassName>/<objectId>.sqlite`. The
  alarm is stored inside that same per-object SQLite file.
- `workerPhysicalName` includes a random suffix saved in
  `.alchemy/state/<Stack>/<stage>/<Worker>.json`, for example
  `kanshispike-kanshispike-spike-cofx45amsdivyfjk`. If you delete
  `.alchemy/state`, change the stage, or rename the Worker or stack, you get
  a **fresh, empty** set of DOs, and the old files are orphaned. The default
  stage is `dev_$USER`. Pin `--stage dev` in `pnpm dev` if you want a stable
  name.
- The Worker dev port defaults to **1337**, which is shared by `alchemy dev`
  and `Test.make({ dev: true })`. Do not run both at once, or set
  `dev: { port: Config.Number("PORT").pipe(Config.withDefault(1337)) }` on
  the Worker (see `.repos/alchemy/examples/cloudflare-dev/src/EffectWorker.ts`).
- To stop dev, send SIGINT to `alchemy/bin/cli.js dev` (Ctrl-C). It shuts
  down workerd cleanly. `pkill -f "alchemy dev"` does **not** match the
  process. Its command line is `node .../alchemy/bin/cli.js dev ...`.
- A file change hot-reloads the worker. This restarts workerd and keeps
  storage and alarms.

### Patterns that work

#### DO class and implementation (tagged / modular form)

Use the tagged form (class declared with an explicit shape, then `.make()`)
so one DO can depend on another and the Worker provides both layers.
**Declare `alarm` in the shape.** Otherwise tsc does not check that its
error channel is `never`: the spike's first version leaked `SqlError`
unnoticed. A side effect is that `alarm` is also callable as an RPC method
from the stub, so don't call it.

```ts
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";

export class Monitor extends Cloudflare.DurableObject<
  Monitor,
  {
    configure: (input: ConfigInput) => Effect.Effect<MonitorStatus, never, RuntimeContext>;
    status: () => Effect.Effect<MonitorStatus, never, RuntimeContext>;
    alarm: (info?: Cloudflare.AlarmInvocationInfo) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("Monitor") {}

export const MonitorLive = Monitor.make(
  Effect.gen(function* () {
    // outer (init): resolve refs only — no storage I/O here
    const state = yield* Cloudflare.DurableObjectState;
    const registries = yield* Registry; // other DO class's namespace
    return Effect.gen(function* () {
      // inner (per instance, runs under blockConcurrencyWhile before any
      // call): storage I/O, sql client, migrations
      ...
      return { configure, status, alarm };
    });
  }),
);
```

#### Hosting both DOs on the Worker, and RPC

```ts
export default class Kanshi extends Cloudflare.Worker<Kanshi>()(
  "Kanshi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const monitors = yield* Monitor;
    const registries = yield* Registry;
    return {
      fetch: Effect.gen(function* () {
        const status = yield* monitors.getByName(monitorId).status();
        const rows = yield* registries.getByName("registry").list();
        ...
      }),
    };
  }).pipe(Effect.provide(MonitorLive.pipe(Layer.provideMerge(RegistryLive)))),
) {}
```

`Layer.provideMerge` gives `MonitorLive` its `Registry` dependency and
exposes both tags to the Worker. Each DO is registered and exported once.
The stack file only does `yield* Kanshi`.

RPC notes:

- Stub methods have exactly the declared shape types. Arguments and results
  go through structured clone, so use plain data.
- Typed errors only come back as class instances if the class is declared
  with `{ errors: [MyError] }` (second argument of
  `Cloudflare.DurableObject<Self, Shape>()("Name", { errors })`). Otherwise
  the caller sees a plain `{ _tag, ... }` object.
- A transport failure is `RpcCallError` from `makeRpcStub`
  (`Cloudflare/Workers/Rpc.ts`) and is **not** in the stub's typed error
  channel. Wrap cross-DO calls whose failure must not abort the caller in
  `Effect.catchCause` (or `Effect.exit`), as the spike's alarm does:

```ts
const count =
  yield *
  registries
    .getByName("registry")
    .recordFire(name, now)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logError("registry call failed", cause).pipe(Effect.as(-1))
      )
    );
```

#### Effect SQL client and migrations over DO SQLite

`@effect/sql-sqlite-do` is now a direct dependency. pnpm 12 first wrote the
importer entry without its peer suffix, which left a dangling
`node_modules/@effect/sql-sqlite-do` symlink. The lockfile entry was fixed by
hand to `4.0.0-rc.117(effect@4.0.0-rc.117)`.

```ts
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const migrations = SqliteMigrator.fromRecord({
  "1_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), ...)`;
  }),
});

// inside the inner (instance) Effect:
const context =
  yield * Layer.build(SqliteClient.layer({ storage: state.raw.storage }));
const sql = Context.get(context, SqliteClient.SqliteClient);
yield *
  SqliteMigrator.run({ loader: migrations }).pipe(
    Effect.provideContext(context),
    Effect.orDie // instance is unusable without its schema
  );
```

- The inner (instance) Effect runs again on **every activation** of the same
  object: after an eviction, a hot reload or a restart. The logs showed the
  same object id running migrations several times, with "applied: 0" each
  time after the first. Keep it cheap and idempotent.
- Pass `storage` (the raw `cf.DurableObjectStorage`, `state.raw.storage`),
  not `db`. Without `storage`, `withTransaction` fails.
- Migrations are recorded in `effect_sql_migrations` and ran exactly once
  across restarts. The migration keys must match `<id>_<name>`.
- `sql.withTransaction(effect)` rolls back when `effect` fails. This was
  verified: an insert followed by `Effect.fail` left 0 rows. Keep `fetch`
  and cross-DO RPC out of transactions.
- `SqlSchema.findAll({ Request: Schema.Void, Result, execute })` decodes
  rows. Call it as `findAll()`, with no argument (lint rejects
  `findAll(undefined)`).
- Raw `state.storage.sql.exec(query, ...bindings)` (the alchemy wrapper,
  `Effect<SqlCursor>` with `.toArray()` / `.one()`) also works. The spike's
  Registry used it, including `INSERT ... ON CONFLICT ... RETURNING`. Prefer
  the Effect SQL client for consistency and typed `SqlError`.

#### Alarms

```ts
yield * state.storage.setAlarm(Date.now() + ms); // one alarm per object; replaces any previous
yield * state.storage.getAlarm(); // number | null
yield * state.storage.deleteAlarm();
```

- The `alarm` handler receives `info?: AlarmInvocationInfo`
  (`retryCount`, `isRetry`). Re-arm it from inside the handler.
- The bridge (`DurableObjectBridge.ts` `#execute`) rejects the workerd
  `alarm()` promise when the Effect fails or dies, and workerd then retries.
  The plan's "each step catches its own errors" still applies. Letting the
  whole alarm die is only right when a retry of the whole alarm is wanted.
  The retry happens even if the handler already called `setAlarm`.
- Synchronous KV (`state.storage.kv.get/put`) is available if needed, but
  the design keeps everything in SQL tables.

### Nothing blocks the design

No blockers found. Constraints to carry into phase 2:

1. Local dev and tests need the placeholder `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_API_TOKEN` env vars. Keep them out of `.env`.
2. Pin the dev stage, because DO data is keyed by the stage-derived worker
   name.
3. Declare `alarm` in the DO shape so tsc checks it.
4. Cross-DO RPC transport failures are untyped. Handle them with
   `catchCause`.

## Phase 2 (core)

### Layout

- `src/domain/`: pure domain code shared by everything. `monitor.ts`
  (config/state/summary schemas), `monitor-input.ts` (create/patch input
  schemas, defaults, stage-dependent validation), `url.ts` (target URL
  rules), `expected-status.ts`, `probe.ts`.
- `src/monitor/`: the Monitor DO. `machine.ts` (`evaluate`), `cycle.ts`
  (check cycle and `nextAlarmAt`, all pure), `reset.ts` (reset rules,
  pure), `storage.ts` (migrations and typed table access), `errors.ts`
  (RPC errors), `monitor.ts` (the DO class and its implementation).
- `src/registry/`: the Registry DO (`registry.ts`) and its RPC errors.
- `src/storage/sqlite.ts`: `openDurableSql(state, migrations)`, shared by
  both DOs.
- `src/api/`: `spec.ts` (HttpApi spec and error classes), `handlers.ts`
  (create/delete flows over both DOs), `auth.ts` (unchanged).
- `src/dev/routes.ts`: `/_dev/*` fixtures. `src/worker.ts`: the single
  Worker, hosting both DOs. `src/config.ts`: `defineConfig` for
  `kanshi.dev.config.ts` (phase 7 grows it). `scripts/seed.ts`: `pnpm seed`.

### Adding tables and migrations

- Each DO has a `SqliteMigrator.fromRecord` record (`src/monitor/storage.ts`,
  `src/registry/registry.ts`). Add a new `"<n>_<name>"` entry for every
  schema change; never edit an applied one. Migrations run on the next
  activation of each object. Phase 3 should add e.g. `"2_alerts"`
  (notifications, incident_recipients, outbox) to the Monitor and
  `"2_channels"` to the Registry; phase 4 `"3_history"` (daily_rollups).
- The SQL client maps snake_case columns to camelCase rows and
  `sql.insert` keys (`transformResultNames`/`transformQueryNames`). Row
  schemas decode JSON/bit columns (`Schema.fromJsonString`,
  `Schema.BooleanFromBit`), see `ConfigRow`/`StateRow`.
- Group writes with `transact(...)` in `monitor.ts` (one
  `sql.withTransaction`, `SqlError` becomes a defect). No `fetch` or RPC
  inside it.
- `destroy()` deletes every row and keeps the tombstone. **Deviation:** the
  plan says drop the tables; deleting rows keeps the schema so later
  migrations still apply to tombstoned objects.

### Alarm

- `nextAlarmAt(config, state, extra)` in `cycle.ts` takes an `extra` list
  of due times: phase 3 passes the earliest unresolved notification retry
  and pending outbox `nextAttemptAt`, phase 4 sets `nextMaintenanceAt`.
- `rearm` recomputes from storage under a semaphore, so the last alarm
  written always comes from the latest committed state. Every mutating RPC
  and the alarm handler end with it.
- The alarm handler runs steps (`expire`, `check`) wrapped in `logged(step)`
  (errors are logged, later steps and `rearm` still run). Add phase 3/4
  steps the same way, before the final `rearm`. It runs at most one check
  per invocation; a further due check re-arms for now.
- `ensureAlarm()` and `status()` exist for the phase 5 watchdog.

### Check cycle decisions

- A failure that is not a confirm schedules a confirm 5s later and is
  stored uncounted; the confirm is fed to the state machine. **Deviation:**
  when the monitor is already `down`, a scheduled failure is counted and
  fed directly (there is nothing to confirm), so a down target is probed
  once per slot, not twice.
- A confirm after a manual failure is fed but not counted (it is not a
  slot sample). `state.nextSlotAt` keeps the slot after a pending confirm;
  `state.confirmCounted` says whether the confirm stands in for a slot.
- `runNow()` stores the request time; any check that starts at or after it
  clears it, so repeated requests collapse into one and a request made
  during an in-flight check gets its own check afterwards.
- Incident ids are the id of the check that opened them.
- The probe retries once, immediately, on "Network connection lost" (a
  pooled keep-alive connection closed by the target). Found in local dev:
  the Node dev gateway's 5s keep-alive timeout matched the 5s interval and
  every third check failed.

### RPC errors

- RPC errors are `Schema.TaggedError` classes declared on the DO class
  (`{ errors: monitorErrors }`, `{ errors: registryErrors }`). Callers get
  real instances back, so `Effect.catchTags` works across RPC (verified).
- Transport failures (`RpcCallError`) are not in the stub's typed error
  channel. In the API they surface as 500s; inside DOs, wrap cross-DO calls
  that must not fail the caller in `Effect.catchCause` (see `pushSummary`).

### API and dev mode

- Routes are under `/api/monitors` (the old API was at `/monitors`). Create
  returns 201, `POST /:id/check` 202, errors are JSON
  `{ "_tag": "NotFound" | "BadRequest" | "Conflict", "message" }` with
  404/400/409. The list is the Registry's cached summaries (active rows
  only). `public` is accepted on create/patch and stored in the Registry.
- Defaults changed: expected status `2xx` (was 200), failure threshold 1
  (was 2). The `allowHttp` flag is gone (http is allowed, https is the
  default for URLs without a scheme).
- `DELETE` works on a row in any lifecycle, so it also retries a stuck
  delete and can cancel a create in progress.
- Worker config (read at deploy time and bound): `KANSHI_API_TOKEN`
  (required, from `.env`), `KANSHI_DEV_MODE`, `KANSHI_MONITOR_QUOTA`
  (default 100). The main stack sets `KANSHI_DEV_MODE` from the stage
  (`dev` only, see `devStages` in `alchemy.run.ts`); the test stack sets it
  explicitly.
- Dev mode: `/_dev/target`, `/_dev/target/flip/:name` (GET: 200/503, POST
  `?up=true|false` or toggle), `/_dev/webhook?fail=500` + `GET
/_dev/events`, `GET /_dev/registry` (all rows), `GET /_dev/monitors/:id`
  (raw status, checks, incidents); 5s intervals and loopback targets; the
  `x-kanshi-dev-configure-delay` header on create (used by the race test).
  Flip targets and dev events live in the Registry (`dev_flips`,
  `dev_events`).

### Running

- `pnpm dev`: `alchemy dev --stage dev` with placeholder Cloudflare
  credentials, on port 1337. Needs `KANSHI_API_TOKEN` in `.env`.
- `pnpm seed`: creates the monitors in `kanshi.dev.config.ts` whose key
  does not exist yet (waits up to 30s for the stack). Uses
  `KANSHI_API_TOKEN` and `KANSHI_URL`.
- `pnpm test`: vitest unit tests in `test/unit`.
- `pnpm test:integ`: `bun test test/integ`, the Worker run locally by
  `Test.make({ dev: true })` on stage `integ` with real alarms (~60s). Do
  not run it while `pnpm dev` is up (both use port 1337).
