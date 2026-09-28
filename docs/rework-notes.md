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

## Phase 3 (alerts)

### Layout

- `src/domain/channel.ts`: channel kinds, create/patch input schemas,
  `ChannelView` (what the API returns), `checkChannelUrl`, `maskUrl`,
  `hashUrl`. `src/domain/alert.ts`: `Notification` and `OutboxEntry`
  schemas.
- `src/alerts/message.ts`: the message model (`Down`, `Recovered`,
  `DownRecovered`, `Test`), text and the per-kind request
  (`alertRequest`). `src/alerts/delivery.ts`: `deliver` (one POST, never
  fails), `classifyStatus`, `backoffMs`, `maxAttempts`.
- `src/monitor/outbox.ts`: the pure rules (notification waiting and due
  times, `outboxDecision`, `dueOutbox`, `outboxDueAt`, `afterAttempt`,
  `skipped`, `deferred`). `src/api/channels.ts`: the channels handlers.
- Migrations: Registry `"2_channels"` (`channels`, plus the dev-only
  `dev_counters`), Monitor `"2_alerts"` (`notifications`,
  `incident_recipients`, `outbox`). Phase 4 should use `"3_history"`. The
  existing dev stage's objects picked the migrations up on activation.

### API

- `GET/POST /api/channels`, `PATCH/DELETE /api/channels/:id`,
  `POST /api/channels/:id/test`. There is no `GET /api/channels/:id` (not
  in the plan; the list is enough so far). A channel is `{ id, key,
managed, kind, name, maskedUrl, urlHash, createdAt, updatedAt }`; `key`
  defaults to the id, is unique (409) and is not patchable; `kind`, `name`,
  `managed` and `url` are.
- The URL is never returned. `maskedUrl` is the origin plus `/****` and,
  when the rest is at least 12 characters, its last 4
  (`https://hooks.slack.com/****abcd`). `urlHash` is the SHA-256 hex of the
  **normalised** URL (the output of `checkChannelUrl`, i.e. `new
URL(...).toString()` after defaulting to `https://`). Phase 7 sync must
  normalise env URLs with `checkChannelUrl` before hashing, or every
  channel will look changed.
- URL rules: the target URL rules (no credentials, local hostnames or
  private IP literals) plus https only. The dev stage also allows loopback
  hosts over http (for `/_dev/webhook`). ntfy access tokens can go in the
  URL (`?auth=...`), which is secret anyway.
- The test endpoint answers 200 `{ delivered, status, error }` whether or
  not the channel accepted it (404 for an unknown channel), so the UI can
  show the error.
- Monitor `channels`: `all` or a list of ids; create/patch reject unknown
  ids with 400 and de-duplicate the list; `[]` means no alerts. Deleting a
  channel does not edit monitors: dangling ids are ignored when recipients
  are resolved (and in-flight rows to it end `failed`, "channel deleted").

### Alert pipeline decisions

- `notifications` has `attempts`, `next_attempt_at`, `last_error` besides
  the plan's columns (**deviation**), for the Registry-unreachable
  backoff. Resolution retries forever (30s doubling, capped at 30m).
- `outbox` has `combined` (a `down` that already said "recovered"),
  `created_at`, `updated_at` besides the plan's columns.
- "If the incident is already resolved when `down` is first sent" is
  checked on **every** attempt: a `down` that failed while the incident
  was open and is retried after recovery goes out as "was down for Xm,
  recovered" and the `up` row is skipped. Tested in integration.
- `down` rows of an incident closed as `disabled` or `deleted` before they
  were sent are **skipped**, not sent (the operator paused it; "recovered"
  would be wrong). A delete wipes the alert tables anyway.
- A Registry failure while resolving a channel at send time defers the
  row with backoff **without** spending one of its 8 attempts.
- Retry schedule: 30s, 1m, 2m, 4m, 8m, 16m, 30m; the 8th failure is final
  (about 61 minutes in total). No jitter.
- `up` notifications waiting for their `down`, and `up` rows waiting for
  their channel's `down` row, are left out of the alarm computation, so a
  waiting row never makes the alarm spin.
- The deliver step sends at most 25 rows per alarm run, one after another,
  each with a 10s timeout, after the check step. The rest re-arm for now.
- Messages use the monitor's name and URL at send time, not at the
  transition.
- `Idempotency-Key` is only sent to `webhook` channels (as the plan says);
  test alerts use `test:<channel>:<uuid>`. Other formats: Slack `{ text }`,
  Discord `{ content, allowed_mentions: { parse: [] } }` (content capped at
  2000), ntfy plain text body with `title`/`priority`/`tags` as query
  parameters (headers cannot carry UTF-8 names).
- At-least-once: a crash between the POST and the outbox write resends the
  same idempotency key on the next alarm.

### Dev mode and tests

- `/_dev/webhook?fail=500&failTimes=N&tag=x` fails only the first N
  requests per tag (counter in the Registry's `dev_counters`); every alert
  is logged as one readable line. `GET /_dev/monitors/:id` now includes
  `alerts` (`notifications`, `outbox`, `recipients`).
- `kanshi.dev.config.ts` has `channels` (a generic webhook and a Slack
  formatted one, both to the dev sink); `pnpm seed` creates missing
  channels by key before monitors.
- Integration tests are split into `test/integ/core.test.ts` and
  `test/integ/alerts.test.ts`, sharing `test/integ/harness.ts`
  (`setup(stage)` makes the `Test.make` API and registers deploy/destroy
  hooks). Each file deploys its own stage (`integ`, `integ-alerts`) on port
  1337, one after the other. The suite takes about 3 minutes; the retry
  test waits the real 30s backoff.

### For later phases

- Phase 4: nothing prunes `notifications`, `incident_recipients` or
  `outbox`; prune them with their incidents. An incidents endpoint could
  expose each incident's alert rows (state, attempts, last error).
- Phase 5: the watchdog's "monitor X is not being checked" alert goes to
  all channels but has no monitor outbox to live in; it needs its own
  durable dedup/outbox (probably in the Registry), reusing
  `alertRequest`/`deliver`. `ensureAlarm()` already accounts for pending
  alert work.
- Phase 6: the channels page uses the endpoints above; show `maskedUrl`
  and the test result's `error`.
- Phase 7: channel config (`ChannelDefinition`) is already in
  `defineConfig`; diff URLs by `urlHash` as described above.

## Phase 4 (history)

### Layout

- `src/monitor/history.ts`: the pure rules. UTC days, `expectedSamples`,
  `periodChange`, `rollupDay`, `percentile`, `isPartial`, `daysToRollUp`,
  `checksPruneBefore`, `incidentsPruneBefore`, `nextMaintenanceTime`,
  `reportDays`, `uptimeReport`. `src/domain/history.ts`: API schemas
  (`Check`, `Incident`, `IncidentWithAlerts`, `DailyRollup`, `UptimeDay`,
  `UptimeReport`). The storage `CheckRow`/`IncidentRow` derive from them.
- Monitor migration `"3_history"`: `enabled_periods` (id, started_at,
  ended_at, interval_seconds), `daily_rollups` (day, counted, up, down,
  expected REAL, p50, p95) and an index on `incidents.resolved_at`. It
  backfills existing monitors: an open period from `created_at` if enabled,
  and `next_maintenance_at = now`. Phase 5+ should use `"4_..."`.

### Counted samples

Verified against phase 2 (unit tests in `monitor.test.ts`, integration in
`core.test.ts` and `history.test.ts`): a scheduled success is counted; a
scheduled failure is stored uncounted and its confirm is counted; while
already `down` a scheduled failure is counted directly (phase-2
deviation); manual checks and a confirm after a manual failure are never
counted. A slot whose check was discarded (stale generation, expired
in-flight) or whose pending confirm was cleared by an edit has no sample;
it shows up as a shortfall against `expected`.

### Decisions

- **Days are UTC.** The status page can label them; per-monitor time zones
  are out of scope.
- **Expected** = enabled time that day / interval in force, from the
  `enabled_periods` log (configure opens one if enabled; disable closes;
  enable opens; an interval edit while enabled closes and opens; delete
  wipes everything). Stored as a real rounded to two decimals, not
  rounded to slots. A day is `partial` when `counted < 0.8 × expected`; a
  day with nothing expected is never partial.
- **Latency** p50/p95 use the nearest-rank method over **successful**
  counted samples only (a timeout's latency is the timeout, not a
  measurement). Uptime is `up / counted` in percent (three decimals), null
  without samples.
- **Maintenance** is a step in the alarm after `deliver`, due at
  `nextMaintenanceAt` = 00:05 UTC daily (`initialState` sets it, so a new
  monitor's alarm includes it; disabled monitors keep a daily alarm, so
  `alarmAt` is no longer null for them). One transaction: roll up each
  closed day after `rolledUpThrough` (from the creation day when null, at
  most 31 days per run; if more remain, `nextMaintenanceAt = now`), write
  the advanced watermark and the next time, then prune. A run that fails
  postpones itself one hour instead of spinning the alarm.
- **Retention.** Raw checks: before `min(end of watermark day, start of
today − 30 days)`, so nothing that is not rolled up is ever pruned.
  `enabled_periods` that ended by the end of the watermark day. Incidents:
  **resolved more than 90 days ago** and with no unresolved notification
  or pending outbox row; then every `notifications`, `incident_recipients`
  and `outbox` row whose incident is gone (alert rows live and die with
  their incident; this closes the phase-3 open issue). Open incidents are
  never pruned. `daily_rollups` are not pruned (one small row per day;
  365/year per monitor).
- **Reads.** `uptime(days)` covers the last `days` days through today,
  not before the creation day. Days at or before the watermark come from
  `daily_rollups` (`live: false`); today and any closed day maintenance
  has not reached yet are computed on read from raw checks (`live: true`),
  with `expected` accruing only up to now.
- **Registry 24h uptime: not added.** Keeping it in the summary would mean
  a query over a day of checks on every check commit (17k rows at 5s), or
  a second rolling aggregate. The dashboard (phase 6) calls
  `GET /api/monitors/:id/uptime?days=1` (or `checks?since=`) per monitor
  instead.

### API

- `GET /api/monitors/:id/checks?since&limit`: checks with `at >= since`
  (epoch ms, default 0), newest first, `limit` 1..1000 (default 100).
  Includes uncounted and manual checks with `kind` and `counted`.
- `GET /api/monitors/:id/uptime?days`: `days` 1..365 (default 90).
  `{ counted, up, expected, uptimePercent, days: [{ day, counted, up,
down, expected, p50, p95, partial, uptimePercent, live }] }`, oldest
  first, today last.
- `GET /api/monitors/:id/incidents?limit`: newest first, `limit` 1..500
  (default 50); each incident carries `alerts` (its outbox rows: event,
  channel, state, attempts, lastError, ...).
- All three 404 for a monitor that is not `active` in the Registry, and 400
  on out-of-range or non-numeric query parameters.

### Dev mode and tests

- `POST /_dev/monitors/:id/maintain?now=<ms>` runs maintenance as of
  `now` (default: the current time) whether due or not and returns
  `{ rolledUp, rolledUpThrough, nextMaintenanceAt, pruned: { checks,
incidents, periods } }` (404 JSON for an unknown monitor). A future
  `now` simulates time passing: the watermark and `nextMaintenanceAt` move
  into the future, so later real checks of those days are never rolled up.
  Use it on throwaway monitors only.
- Unit: `test/unit/history.test.ts` (days, maintenance time,
  percentiles, expected across config changes and day boundaries, period
  changes, rollups, partial flag, report assembly, watermark, cap and
  retention cut-offs). The SQL of rollup/prune is covered by integration.
- Integration: `test/integ/history.test.ts` on stage `integ-history`
  (down/up cycle, the three endpoints, then maintain at +1 day, +40 days,
  +100 days). The suite now takes about 4 minutes.

### Commands (end of phase 4)

- `pnpm exec tsc --noEmit -p .`: pass
- `pnpm check`: pass
- `pnpm test`: pass (99 tests)
- `pnpm test:integ`: pass (15 tests)

Commit `0158818` (maintenance) made disabled monitors keep an alarm; the
alerts integration test that expected `alarmAt` null was updated one
commit later (`cb3dfdb`), so `pnpm test:integ` fails at `0158818` and
`3d169d7` only on that assertion.

### For later phases

- Phase 5: the watchdog's `ensureAlarm()` already includes maintenance. A
  monitor whose `nextMaintenanceAt` is far in the past (e.g. alarms lost)
  catches up on its next alarm; nothing else is needed.
- Phase 6: the dashboard's 24h uptime and sparkline come from
  `uptime?days=1` and `checks?since=<now-24h>&limit=...`; the detail page
  uses `uptime?days=90` (grey for `partial`, empty for `uptimePercent:
null`) and `incidents`. The status page's Cache API entry can hold the
  `uptime` response.
- Rollups are never recomputed: a day rolled up is final even if a late
  config-log fix would change its `expected`.

## Phase 5 (watchdog and reconciliation)

### Layout

- `src/watchdog/rules.ts`: the pure rules. `needsStatus`, `decide(row,
status, now)` (`Wait | Activate | Abandon | Destroy | Refresh | Skip`),
  `staleThresholdMs`, `lastSignOfLife`, `isStale`, `observe`,
  `watchTransition` (stale counter and episode changes `open | resolve |
close | none`) and the constants (`creatingGraceMs` 5m, `staleGraceMs`
  2m, `staleRunsToAlert` 2, `watchdogConcurrency` 8, `episodeRetentionMs`
  30d).
- `src/watchdog/run.ts`: `runWatchdog(deps, now)`, shared by the cron and
  the dev route. Returns a `WatchdogReport` (one `RowReport` per row).
- `src/registry/watchdog-store.ts`: Registry migration `"3_watchdog"`
  (`monitors.stale_runs`, `monitors.stale_episode_id`,
  `watchdog_episodes`, `watchdog_outbox`) and its SQL. Phase 6+ Registry
  changes should use `"4_..."`.
- `src/alerts/message.ts`: `NotChecked`, `NotCheckedResolved`,
  `CheckedAgain` messages.
- `src/worker.ts`: `Cloudflare.Workers.cron(watchdogCron, ...)` with
  `Cloudflare.Workers.CronEventSourceLive` (alchemy attaches the trigger
  at deploy time and registers the `scheduled` listener).

### What a run does

`registry.list()`, then every row independently (`Effect.forEach`,
concurrency 8, each row's failure caught, logged and reported as
`action: "Error"`):

- `creating` younger than 5 minutes: nothing (`Wait`). Older: `status()`;
  configured and not tombstoned → `activate(id, opId)`; otherwise →
  `markDeleting(id, opId)` (only that operation's `creating` row) →
  `destroy()` → `remove()`. The tombstone makes a delayed `configure`
  fail, so the create answers 409 and nothing is armed (tested).
- `deleting`: `destroy()` then `remove()`, whatever its age (both
  idempotent, so racing an API delete is harmless).
- `active`: `status()`, then three independent steps (a failure of one is
  reported and the others still run): `ensureAlarm()`,
  `upsertSummary(id, summary, state.summaryRevision)` (same revision
  rule as pushes, so it converges disabled monitors too and never
  overwrites a newer push), and `registry.observe(id, observation, now)`.
- Afterwards: `pruneWatchdog(now - 30d)` and the Registry's own
  `ensureAlarm()`.

### Decisions

- **Stale** = enabled and `now - max(lastCheckedAt, config.createdAt,
config.updatedAt) > 2 × interval + 2 min` (**deviation**: the plan
  only names `lastCheckedAt`). A never-checked monitor counts from its
  creation, and every edit (which resets the schedule) restarts the
  clock, so a re-enabled monitor with an old `lastCheckedAt` is not
  flagged before it had a chance to run.
- **Counter**: `stale_runs` counts consecutive stale runs; any fresh or
  disabled run resets it. The second consecutive stale run opens an
  **episode** (`watchdog-<uuid>`) and queues one `down` row per channel
  (all channels, as the plan says, not the monitor's selection). While the
  episode is open nothing else is sent. A fresh run resolves it
  (`recovered`) and queues an `up` row for every channel that got a
  `down` row. Disabling closes it (`disabled`) silently; deleting the
  monitor closes it (`deleted`) in `remove()`. "Consecutive" means
  consecutive runs; there is no minimum spacing, so a dev run and the
  cron count the same.
- **Delivery (at-least-once)**: a Registry-side outbox driven by a new
  **Registry alarm** (`alarm = min(sendable nextAttemptAt)`, recomputed
  after every change, like the Monitor). The outbox has the Monitor's
  outbox shape (`incident_id` holds the episode id) so it reuses
  `outboxDecision`, `dueOutbox`, `outboxDueAt`, `afterAttempt`,
  `skipped` and `deliver`: 8 attempts with backoff, 4xx permanent, the
  recovery only after the channel's `down` was delivered, a `down` still
  pending when the episode resolves goes out as "was not checked for Xm,
  checks resumed" and its `up` is skipped, and a `down` of an episode
  closed by disable/delete is skipped. Channels are local to the Registry,
  so opening/resolving an episode fans out in the same transaction with no
  RPC. At most 25 rows per alarm run. Idempotency key:
  `<episode>:<down|up>:<channel>`.
- **Messages**: "Kanshi: monitor X is not being checked" (body: last
  check age and expected interval, URL), "monitor X is being checked
  again after Xm", "monitor X was not checked for Xm, checks resumed".
  Webhook body: `event: "not_checked" | "checked"`, `episode` (with
  `durationMs`), `incident: null`. ntfy priority `high`, tag `warning`.
- `activate(id, opId)` is now **idempotent**: it also succeeds when that
  operation's row is already `active`, so a create request that finishes
  after the watchdog activated its row still answers 201.
- An `active` row whose monitor is tombstoned or unconfigured is only
  logged and reported (`Skip`); the watchdog does not guess a repair.
- `now` (dev) is the run's clock for the `creating` age, staleness and
  episode timestamps; queued alert rows are always due at the real time so
  the Registry alarm sends them immediately. Durations in those messages
  then read "0s".
- **Cron failure semantics**: alchemy's cron event source swallows handler
  failures, so Cloudflare never retries a run; the next one comes 5
  minutes later. Nothing in a run needs retrying within it.
- Resolved episodes and their rows are pruned 30 days after resolution
  (only when none of their rows is pending), at the end of each run.

### Dev mode and tests

- `POST /_dev/watchdog?now=<ms>` runs the watchdog (default now) and
  returns the report; `GET /_dev/watchdog` lists recent episodes and their
  alert rows.
- `POST /_dev/monitors/:id/clear-alarm` deletes a monitor's alarm (a lost
  alarm); `POST /_dev/registry/:id/mark-deleting` marks a row `deleting`
  without deleting the monitor (a stuck delete); `POST
/_dev/registry/:id/rewind` sets a row's summary to name `(stale)`,
  status `unknown`, revision 0 (lost pushes); the create header
  `x-kanshi-dev-skip-activate: 1` stops after `configure` (a create that
  died before `activate`). `GET /_dev/registry` rows now include
  `watch: { staleRuns, episodeId }`.
- Locally the cron also runs for real every 5 minutes, and can be fired
  with `POST /cdn-cgi/handler/scheduled?cron=<encodeURIComponent("*/5 * * * *")>` (tested).
- The dev router is now a route table (`routes` in `src/dev/routes.ts`).
- Unit: `test/unit/watchdog.test.ts` (decisions for every lifecycle,
  threshold and reference time, counter/dedup sequences, message text and
  payloads).
- Integration: `test/integ/watchdog.test.ts` on stage `integ-watchdog`
  (about 25s): lost alarm restored and checks resume, stuck create
  activated, stuck create removed with the late configure rejected, stuck
  delete finished, cron trigger, rewound summary of a disabled monitor
  converges (and a second run does not rewrite it), not-being-checked
  alert sent once to the dev sink (third stale run deduplicated), then one
  recovery. The suite takes about 3.5 minutes.

### Commands (end of phase 5)

- `pnpm exec tsc --noEmit -p .`: pass
- `pnpm check`: pass
- `pnpm test`: pass (119 tests)
- `pnpm test:integ`: pass (22 tests)

### Open issues and for later phases

- The integration stages also get the real 5-minute cron. A real run that
  lands between the two `now = +1h` runs of the not-being-checked test
  would reset the counter and fail it (a window of milliseconds every 5
  minutes).
- The Registry is a singleton that now also sends watchdog alerts. While a
  delivery awaits `fetch` (10s timeout, at most 25 per alarm run) other
  Registry calls interleave, so it does not block the API, but a very
  large backlog is spread over several alarm runs.
- Episodes are visible only through `/_dev/watchdog` and the report; phase
  6 could show an open episode on the dashboard (the Registry row already
  carries `watch.episodeId`).
- A Registry row whose monitor lost its config (active + unconfigured) is
  reported, not repaired.

## Phase 6 (UI)

### Layout

- `src/service/{monitors,channels,status}.ts`: the operations behind both
  the `/api` handlers and the pages (create/delete flows, reads, channel
  test, public status). `src/api/handlers.ts` and `src/api/channels.ts` are
  now thin adapters; `src/api/public.ts` serves `GET /api/public/status`.
- `src/ui/html.ts`: the `html` tagged template (escapes every
  interpolation that is not already `Html`; arrays are joined; `false`,
  `null`, `undefined` render nothing), `raw`, `safeHref`.
- `src/ui/session.ts`: session values, `Set-Cookie` strings and the Origin
  check. `src/ui/charts.ts`: uptime bars and sparkline (inline SVG).
  `src/ui/format.ts`, `src/ui/forms.ts` (form body -> API input, readable
  schema errors), `src/ui/layout.ts` (the one CSS block, the inline script,
  the page shell), `src/ui/pages.ts`, `src/ui/status-page.ts`,
  `src/ui/routes.ts` (the page router). `src/http/route.ts`: the path
  matcher shared with `/_dev/*`.
- `src/domain/public-status.ts`: the public status schema and
  `overallStatus`.
- Worker routing: `/api/*` -> HttpApi, `/_dev/*` (dev stage) -> fixtures,
  everything else -> pages (404 page for unknown paths).

### Auth and CSRF

- `/login` takes the API token (timing-safe compare) and sets
  `kanshi_session=<expiresAt>.<hex HMAC-SHA256>`; the HMAC key is derived
  from the token, the message is the expiry. `HttpOnly; Secure;
  SameSite=Strict; Path=/; Max-Age=30d`. Verification uses
  `crypto.subtle.verify` (constant time) and checks the expiry. No state
  is stored: rotating `KANSHI_API_TOKEN` logs everyone out.
  **Deviation/addition:** sessions expire after 30 days.
- `/logout` clears the cookie in the browser only; a copied cookie stays
  valid until it expires or the token rotates.
- `/api` security is `bearer` OR `session` (cookie `kanshi_session`,
  Effect's `HttpApiSecurity.apiKey({ in: "cookie" })`; schemes are tried
  in order). A cookie-authenticated request that is not GET/HEAD/OPTIONS
  must pass the Origin check, otherwise 403. Bearer requests are not
  Origin-checked.
- Origin check (`isSameOrigin`): the `Origin` header must equal the
  request URL's origin; without an `Origin` header only
  `Sec-Fetch-Site: same-origin` passes. Every page form post (including
  `/login` and `/logout`) is checked; failures get a 403 page.
- Page form posts read the body **before** rejecting: answering a POST
  with an unread body made the local dev gateway reset the connection
  (`ECONNRESET` in the integration tests).
- Signed-out requests to dashboard pages redirect (303) to `/login`.
- Every page: `Cache-Control: no-store`, a CSP (`default-src 'none'`,
  inline style and script allowed, `form-action 'self'`,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, `nosniff`.

### Pages

- `/`: status, last check, 24h uptime, 24h latency sparkline, interval,
  public and "not checked" badges; a banner lists monitors with an open
  watchdog episode (`watch.episodeId`, free from `registry.list()`);
  counts per status; the dev stage adds the webhook sink's last 20
  `dev_events`. Auto-refreshes every 30s.
- `/monitors/:id`: header with status, public/private, URL (link only if
  http(s)); buttons check now (enabled only), pause/resume, make
  public/private, edit, delete (JS confirm); 90-day bars; 24h latency;
  incidents with each alert row (event, channel name, state, last error);
  the last 50 checks (kind, counted, result, HTTP, latency, message);
  settings.
- `/monitors/new`, `/monitors/:id/edit`: one form. Timeout is entered in
  seconds. Channels: "all" or a checkbox list. Unchecked boxes mean false
  (the edit form sets every field, including `public` and `enabled`).
  Errors re-render the form with the submitted values (400).
- `/channels`: each channel with kind, masked URL, "send test alert" (the
  result is rendered inline, including the error), delete (confirm), and
  an inline edit form (empty URL keeps the stored one); an add form.
- Success after a redirect is a fixed message chosen by `?done=<code>`;
  nothing from the query string is echoed.
- The inline script only rewrites `<time data-local>` to local time and
  asks for confirmation on `form[data-confirm]`; everything works without
  it. Days on bars are UTC.
- Bars: `>= 99.5%` green, `>= 95%` amber, below red, `partial` grey (even
  when a percentage exists), no samples blank; a young monitor is padded
  on the left so every chart has 90 bars.

### 24h uptime and sparkline

**Change from the phase-4 note:** instead of `uptime?days=1` (a UTC day)
plus a checks scan, the Monitor DO has a new RPC `recent(windowMs,
buckets)`: one aggregate over the last 24h (counted samples and up) and
one `GROUP BY` into 48 half-hour buckets (mean latency of successful
checks, counted failures). It is a rolling 24 hours and reads no rows into
the Worker. Not exposed over `/api`.

### Public status

- `makeStatusService().publicStatus()`: every request calls
  `registry.list()` and keeps active rows with `public = true`, so a
  monitor made private (the API's `PATCH` writes `public` to the Registry
  before answering) disappears on the next request. For each, the 90-day
  history comes from the Cache API (`caches.default`, key
  `https://kanshi.cache/status-history/v1/<id>`, `max-age=300`) or from
  `monitor.uptime(90)`; a down monitor's open incident start is read live.
  Failures of one monitor render it without history.
- `GET /api/public/status` (no auth, `no-store`,
  `Access-Control-Allow-Origin: *`): `{ generatedAt, overall:
operational | partial_outage | major_outage, monitors: [{ name, status:
up | down | unknown | paused, lastCheckedAt, uptimePercent, downSince,
days: [{ day, partial, uptimePercent }] }] }`. No URLs, ids, keys or
  incident causes (a cause can contain a hostname).
- `/status` renders the same data: banner, open incidents ("X is down
  since ..."), per-monitor bars. Auto-refreshes every 60s.

### Gotchas

- **Tagged templates containing `</script>`** are compiled by the Oxc
  transform (used by `alchemy dev` for the stack) with a runtime helper
  from `@oxc-project/runtime`, which is not installed, and the stack fails
  to load. `layout.ts` builds the `<script>` element from a plain template
  string instead. Keep `</script` out of `html` templates.
- `oxfmt` formats `html` templates as HTML (re-indents, moves `${}`
  onto their own lines). Harmless in HTML; unit tests compare markup after
  collapsing whitespace between tags.
- The SQL bucket index needs `CAST(... AS INTEGER)`: bound numbers are
  REAL, so `/` did not divide integers.

### Tests

- Unit: `test/unit/session.test.ts` (escaping, composition, `safeHref`,
  session derivation/verification incl. rotation, expiry and tampering,
  cookie attributes, Origin check) and `test/unit/ui.test.ts` (bar levels,
  padding and trimming, sparkline path and gaps, failure marks,
  `recentActivity`, formatting, form mapping and errors, overall status,
  status page escaping).
- Integration: `test/integ/ui.test.ts` on stage `integ-ui` (about 10s):
  sign-in flow and cookie attributes, signed-out redirect, cookie auth on
  `/api` with the Origin rule, forged cookie, logout; form posts with a bad
  or missing Origin rejected (create and delete); a monitor made private
  (API `PATCH` and the dashboard button) disappears from `/status` and
  `/api/public/status` on the next request; the status page and JSON show
  only public monitors and no URLs or ids. The harness has a `raw`
  request helper (no bearer, redirects not followed).

### Manual check

`pnpm dev` + `pnpm seed`, then curl and a browser: login (good, wrong
token, cross-origin), dashboard, detail, new/edit forms (valid and
invalid input, escaping of a `<b>` name), pause/resume/check/public
buttons, channels (create with a bad and a good URL, test, edit, delete,
test of a deleted channel -> 404 page), `/status` and
`/api/public/status` while the flip target was down (banner "Major
outage", open incident), cookie-authenticated `/api` writes with and
without Origin, logout. No errors in the dev log.
