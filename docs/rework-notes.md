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
