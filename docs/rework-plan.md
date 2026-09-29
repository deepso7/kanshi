# Kanshi rework plan

## Goal

Turn Kanshi into a small, reliable, self-hosted uptime monitor that is easy to
run and use: one Cloudflare Worker, one secret, a local dev mode that works
offline, a minimal dashboard and a public status page.

## Decisions

- **One Durable Object per monitor** owns that monitor's config, state,
  incidents, check history and alert outbox in its own SQLite storage and
  drives itself with its alarm. The cross-invocation claim/lease machinery
  over D1 is deleted. Durable Objects can still interleave requests while
  awaiting `fetch` or RPC, so each monitor keeps a config **generation** and a
  single **in-flight check** record (see below).
- **One `Registry` Durable Object** (singleton) owns monitor existence
  (lifecycle), the `public` flag, and alert channels. It caches a status
  summary per monitor for listing and the status page.
- **Drop Tinybird and D1.** History and uptime live in each monitor's SQLite.
  Drizzle, drizzle-kit and Tinybird code, config, skills and vendored SDK are
  removed.
- **One Worker** serves the API, dashboard, status page and a watchdog cron.
- **Keep Effect v4 and Alchemy**, following `.repos/effect` and
  `.repos/alchemy` patterns (`Cloudflare.DurableObject`,
  `DurableObjectState`, `storage.sql`, `storage.setAlarm`).
- **Do not use Alchemy's `scheduleEvent`/`processScheduledEvents`.** It
  deletes or advances an event before the handler runs, so a crash loses the
  work. Instead the alarm is always derived from persisted state (below).
- **UI:** minimal server-rendered dashboard (auth required) and public status
  page. No frontend framework or build step.
- **Clean break.** No data migration from the current D1/Tinybird setup; the
  old stack is destroyed after the new one is deployed.
- **Delivery guarantee:** alerts are at-least-once.

## Non-goals

Multi-region probing, multi-user accounts, SMS/email channels, Tinybird
export (possible later as an optional add-on).

## Architecture

```
Worker (fetch + cron "17 * * * *", hourly)
 ├─ /api/*         Effect HttpApi, bearer token or session cookie
 ├─ /              dashboard (HTML, session cookie)
 ├─ /status        public status page (HTML) + /api/public/status (JSON)
 ├─ /_dev/*        dev stage only: fake target, webhook sink, run-now
 └─ cron           watchdog + reconciliation
Monitor DO (name = monitor id)   Registry DO (name = "registry")
```

### Monitor DO storage

Tables (`CREATE TABLE IF NOT EXISTS` at start, plus a `schema_version` row):

- `config` (single row): key (stable slug, for config-as-code), managed flag,
  name, url, method, expected status spec (`200`, `2xx`, or list), optional
  `bodyContains`, timeoutMs, intervalSeconds, failureThreshold,
  successThreshold, enabled, channel ids (or `all`), **generation**.
- `state` (single row): status `unknown|up|down`, failure/success streaks,
  lastCheckedAt, last result summary, open incident id, `nextCheckAt`,
  `nextCheckKind` (`scheduled|confirm`), `manualRequestedAt` (or null),
  `inflight` (checkId, generation, kind, startedAt, or null),
  `summaryRevision` (monotonic, bumped by a change of the Registry
  summary: status, enabled, name, URL or interval; a check that changes
  none of them leaves it alone, with one exception: a check or edit that
  revives a stale monitor, one the watchdog would call not being checked,
  bumps it once even when the summary is unchanged, so the push lets the
  watchdog reject observations read before it), `nextMaintenanceAt`,
  `rolledUpThrough` (day).
- `tombstone` (single row, only after delete): deletedAt. Once present,
  `configure` and every mutating RPC are rejected and the alarm is cleared.
- `checks`: checkId, at, kind (`scheduled|confirm|manual`), counted (bool),
  ok, status, latencyMs, errorKind. 30-day retention.
- `daily_rollups`: day, counted checks, up, down, expected, p50, p95.
- `incidents`: id, startedAt, resolvedAt, resolution
  (`recovered|disabled|deleted`), cause, lastHttpStatus.
- `notifications`: incident id, event (`down|up`), createdAt, resolved (bool)
  — the durable intent to alert, written in the same transaction as the
  transition.
- `incident_recipients`: incident id, channel id — the recipient set, fixed
  once when the `down` notification is resolved.
- `outbox`: incident id, event, channel id, attempts, nextAttemptAt,
  lastError, state (`pending|delivered|failed|skipped`). Primary key
  `(incident, event, channel)`.

### Alarm = f(persisted state)

The alarm handler does all due work, then sets the alarm to the minimum of:
`nextCheckAt` or `manualRequestedAt` (if enabled and no in-flight check), in-flight timeout
(`startedAt + timeoutMs + 30s`), earliest unresolved `notifications` retry,
earliest pending `outbox.nextAttemptAt`, `nextMaintenanceAt`. Every RPC that
changes state ends by recomputing and setting the alarm. Because work is
derived from rows rather than consumed events, a crash at any point is
recovered by the next alarm (Cloudflare retries failed alarms) or by the
watchdog's `reconcile()`. Every step is idempotent. Alchemy's alarm type is
`Effect<void, never, never>`: each step catches its own errors so one failure
cannot stop the others or skip rescheduling.

### Check cycle (single-flight)

1. Alarm sees `nextCheckAt <= now` and `inflight` null (or expired): writes
   `inflight = {checkId, generation, kind}` and commits before fetching.
2. Probes.
3. Commits the result **only if** `inflight.checkId` and `generation` still
   match; otherwise records nothing and logs "stale result discarded". Clears
   `inflight`.
4. Scheduled check fails and a confirm is not already the current kind →
   `nextCheckKind = confirm`, `nextCheckAt = now + 5s`; the failed probe is
   stored with `counted = false`. The confirm result is the one counted and
   fed to the state machine. Otherwise `nextCheckKind = scheduled`,
   `nextCheckAt = previous due time + interval` (skipping missed slots, never
   bursting).
5. `runNow()` (dashboard "check now", dev fixtures) sets
   `manualRequestedAt` (coalesced: repeated requests collapse into one) and
   re-arms; it never probes inline, so it cannot race the alarm. When no check
   is in flight, a pending manual request runs as kind `manual` and is
   cleared on completion; `nextCheckAt` and `nextCheckKind` are untouched, so
   scheduled slots and confirms keep their identity. Manual results feed the
   state machine (a manual failure schedules a confirm like a scheduled one)
   but are never counted in uptime.

### State machine

Pure function `evaluate(state, config, result) -> { state, transition }`,
`transition ∈ none|down|up`, unit tested. Down after `failureThreshold`
confirmed failures (default 1). Up after `successThreshold` successes
(default 1).

Reset rules (carried over from today's `updateMonitor`/`removeMonitor`):

- Any probe-affecting config edit: bump generation, reset streaks, clear
  in-flight and pending confirm, `nextCheckAt = now`. Status is kept.
- Disable: bump generation, status → `unknown`, streaks reset, close open
  incident with `disabled` (no alert), clear pending confirm.
- Enable: bump generation, status `unknown`, `nextCheckAt = now`. A
  still-down target therefore opens a new incident and alerts.
- Delete: close open incident with `deleted`, clear the alarm, drop all
  tables and write the `tombstone` row, all in one transaction.

### Probe

`fetch` with `AbortSignal` timeout, `redirect: "follow"`, bounded body read
(1 MB) when `bodyContains` is set or for GET latency. Error kinds: `timeout`,
`dns`, `tls`, `connection`, `status`, `keyword`, `network`. URL rules on save:
http(s) only, https by default, no credentials, no `localhost`/`.local`-style
hosts or private IP literals. The DNS-over-HTTPS resolution in
`src/domain/url.ts` is removed: there is one trusted operator, and Workers
`fetch` cannot reach private networks.

### Alerts

Channels are global (Registry) with kinds `slack`, `discord`, `webhook`
(generic JSON POST), `ntfy`. A monitor uses all channels unless it lists
specific ones.

1. A transition writes a `notifications` row in the same transaction as the
   state change. No cross-DO call happens inside the transaction.
2. The alarm resolves unresolved notifications. For `down`: fetch the
   monitor's channels from the Registry, store them in
   `incident_recipients`, insert one `outbox` row per channel
   (`INSERT OR IGNORE`), mark resolved, all in one transaction. For `up`: wait
   until the incident's `down` notification is resolved, then fan out to the
   same `incident_recipients` set, so every channel that got "down" gets
   "recovered" and no channel gets a recovery without a down. If the Registry
   is unreachable, retry with backoff; the check result is already
   committed.
3. Delivery resolves the channel's URL from the Registry at send time
   (deleted channel → row `failed`), retries with exponential backoff (30s →
   ~30m, max 8 attempts), and treats 4xx other than 408/425/429 as permanent.
4. Ordering per channel: an `up` row is sent only after the `down` row for
   the same incident and channel is `delivered`. If that `down` row ends
   `failed`, the `up` row is marked `skipped` and never sent, so a channel
   never gets a recovery for an outage it was not told about. If the incident
   is already resolved when `down` is first sent, the message says so
   ("was down for Xm, recovered") and the separate `up` row is skipped.
5. Generic webhooks get an `Idempotency-Key: <incident>:<event>:<channel>`
   header and the same id in the body.

Webhook URLs are write-only secrets: never returned by the API; the API
returns a masked form and a SHA-256 hash (used by config sync to diff).
`POST /api/channels/:id/test` sends a test message.

### Registry DO

Tables:

- `monitors`: id, key, managed, lifecycle (`creating|active|deleting`),
  opId (random id of the current create/delete operation), public, summary
  (name, status, enabled, intervalSeconds, url; no last check time, which
  changes every check), summaryRevision, the open watchdog episode id,
  updatedAt.
- `channels`: id, key, managed, kind, url, urlHash, name.
- `dev_events` (dev stage only).

Rules:

- Create: `registry.begin(id, key)` inserts `creating` with a fresh opId
  (quota enforced, default 100, key unique) → `monitor.configure(id, config)`
  (idempotent, rejected if tombstoned) → `registry.activate(id, opId)`, which
  only succeeds if the row is still `creating` with that opId.
- Delete: `registry.markDeleting(id)` → `monitor.destroy()` (idempotent,
  leaves the tombstone) → `registry.remove(id)`. A delayed `configure`
  arriving after this hits the tombstone and fails, so no orphan monitor can
  be re-armed.
- A monitor pushes its summary (`upsertSummary`) only when it changed: a
  status transition, enable/disable, or an edit of the name, URL or
  interval (`shouldPushSummary`: the revision moved), or a check or edit
  revived a stale monitor (the one bump above). A check that changes
  nothing makes no Registry request, so the Registry is not kept awake by
  checks. A failed push is retried on the next check (in memory) and
  otherwise converged by the watchdog.
- `upsertSummary` is rejected when the row is missing or `deleting`, or when
  its `summaryRevision` is not newer than the stored one. Pushes and the
  watchdog's batched refresh use the same revision, so a delayed snapshot
  can never overwrite a newer status.
- Readers that need the last check time read it live from the monitor:
  the dashboard overview gets it (with the live status and staleness) in
  the same per-monitor call as its 24h activity (`Monitor.overview`), the
  detail page from the snapshot. `GET /api/monitors` and the public status
  carry only what the Registry knows (no `lastCheckedAt`).
- `public` is owned here and written synchronously by the API, so the status
  page never publishes a monitor that was made private.

### Watchdog (cron hourly, `17 * * * *`)

`registry.list()`, then for **every** registry row (bounded concurrency):

- `creating` older than 5 min: ask the DO `reconcile()`; configured →
  activate with the row's opId, not configured → run the normal delete
  path (opId-conditional `markDeleting` → `destroy()` → `remove()`), which
  tombstones the DO so a delayed `configure` cannot arm an orphan.
- `deleting`: retry `destroy()` then `remove()`.
- `active`: exactly **one** call, `monitor.reconcile()`: it re-arms the
  alarm from persisted state and returns the status (summary, revision,
  last check, schedule reset, tombstone).

Then **one** batched `registry.reconcile(items, now)` for every active
monitor, each item its own transaction: store the summary under the
revision rule (so failed pushes converge, including for disabled
monitors) and record the observation. If enabled and not checked for
longer than `max(2 × interval + 2 min, 10 min)` (measured from the last
check, creation or schedule reset), one observation opens an episode and
alerts all channels "Kanshi: monitor X is not being checked"
(deduplicated until it recovers; a fresh observation sends the recovery,
disabling closes it silently). The batch does not open episodes itself:
it returns those monitors as suspects, the watchdog reads each suspect
again (`status()`, after the batch), and one `registry.confirmStale`
opens episodes only for those still stale, enabled and active at the
same revision, so a check or disable the monitor committed but had not
yet pushed never opens one. The batch prunes old episodes; both calls
re-arm the Registry's alarm, which is set only while watchdog alerts are
due. A run is `2 + active monitors` requests in the steady state
(nothing opens), and `3 + active monitors + suspects` when a monitor is
found stale; a silently stuck monitor is noticed within about 1–2 hours.

## History and uptime

- Only `counted` samples (one per scheduled slot: the scheduled result, or
  its confirm) count toward uptime and latency.
- `expected` per day = enabled seconds that day / interval, tracked from
  config changes. Days with counted < 80% of expected render as "partial"
  (grey), so gaps are not reported as 100% uptime.
- Maintenance (daily): roll up every closed day after `rolledUpThrough`, then
  advance the watermark in the same transaction; prune raw checks only for
  days ≤ watermark and older than 30 days. The current day is computed on
  read.

## API

Effect `HttpApi`, bearer token (`KANSHI_API_TOKEN`, timing-safe compare) or
dashboard session cookie.

- `GET/POST /api/monitors`, `GET/PATCH/DELETE /api/monitors/:id`,
  `POST /api/monitors/:id/check`
- `GET /api/monitors/:id/checks?since&limit`, `/uptime?days=90`,
  `/incidents`
- `GET/POST /api/channels`, `PATCH/DELETE /api/channels/:id` (URL
  replaceable, never readable), `POST /api/channels/:id/test`
- `GET /api/public/status` (no auth; only `public` monitors, no URLs)

## UI

Server-rendered HTML with plain forms and a little inline JS; one CSS block.

- `/login`: paste the API token; sets an `HttpOnly; Secure; SameSite=Strict`
  cookie holding an HMAC-derived session value (rotating the token logs
  everyone out). Form posts also check `Origin`.
- `/`: monitor list with status, last check (both read live from each
  monitor), 24h uptime, latency sparkline (inline SVG).
- `/monitors/:id`: 90-day uptime bars, recent checks, incidents; edit,
  pause/resume, check now, delete.
- `/monitors/new`, `/channels`: add/edit forms, "send test alert".
- `/status`: public page with overall banner, per-monitor 90-day bars, open
  incidents. The page itself is never cached: every request reads the current
  public list from the Registry. Only per-monitor rollup data is cached
  (Cache API, 5 min, keyed by monitor id), and it is only rendered for
  monitors that are public right now.

## Config as code

`kanshi.config.ts` with `defineConfig({ channels, monitors })`, keyed by the
stable `key` fields. `pnpm kanshi sync [--url]` diffs against `/api` and
applies creates/updates/deletes, touching only `managed` resources. Monitors
created in the dashboard are left alone. Channel URLs come from env vars and
are diffed by hash.

## Dev mode

- `pnpm dev` runs `alchemy dev` (local workerd, Durable Object SQLite
  persisted on disk), then `pnpm seed` creates the monitors and channels in
  `kanshi.dev.config.ts` that do not exist yet (by `key`). Phase 7 grows this
  into full `sync`.
- Dev stage enables `/_dev/*`:
  - `/_dev/target?status=500&delay=2000&body=...` fake target
  - `/_dev/target/flip/:name` stateful target toggled up/down
  - `/_dev/webhook?fail=500` sink that records alerts in `dev_events`
    (shown on the dashboard, printed to the console)
- Dev allows intervals down to 5s and `http://localhost` targets/webhooks.
  Production minimum interval is 30s.
- No Tinybird or other external service. `LocalWorkerProvider` still
  resolves `CloudflareEnvironment` locally, so the spike (phase 1) decides and documents
  how local dev gets an account id (real login vs. a stub for offline use).

## Testing

- Unit (`vitest` + `@effect/vitest`): state machine, reset rules, check-cycle
  transitions (confirm, stale generation, in-flight expiry), alarm
  computation, expected-status parsing, URL rules, rollups/percentiles and
  watermark, backoff and retry classification, outbox ordering, message
  formatting, config diff.
- Integration (`bun test`, Alchemy test helpers) against the local dev stack.
  Uses real alarms with 5s intervals (not only run-now) for: down after
  confirm, recovery, alert retry after sink 500, disable/enable/delete,
  stale result discarded after an edit mid-probe (carries over the current
  stale-revision test), manual check during an in-flight check is not lost,
  delete racing a delayed configure leaves no running monitor, channel added
  mid-incident gets neither down nor up, making a monitor private removes it
  from `/status` immediately, restart recovery (stop dev mid-cycle, restart,
  monitor resumes and pending alerts are sent), watchdog re-arm, quota, auth,
  status page hides private monitors and URLs.
- `pnpm check` (ultracite) and `tsc` stay green in every phase.

## Removed

`src/db/*`, `drizzle.config.ts`,
`src/engine/{scheduler,state,alerts,tinybird,engine,worker}.ts`,
`src/tinybird/*`, `tinybird.config.json`, most of `src/domain/url.ts`, the
engine worker, deps `@tinybirdco/sdk`, `drizzle-orm`, `drizzle-kit`,
`@effect/sql-d1`, `@effect/sql-pg`, `.repos/tinybird-sdk-typescript`, the two
Tinybird skills, and the Tinybird line in `AGENTS.md`. Test harness workers
are replaced by `/_dev/*` routes.

## Phases

Each phase lands as its own commits on the `rework` branch and ends with
checks and tests passing.

0. **Upgrade.** Before anything else, on the `rework` branch:
   - Bump every dependency that survives the rework to its latest release:
     Effect packages from `4.0.0-beta.101` to `4.0.0-rc.118` (the `beta`
     dist-tag is stale; Effect v4 now ships on `rc`), `alchemy` from
     `2.0.0-beta.64` to `2.0.0-beta.79` (which requires Effect
     `>=4.0.0-rc.115`), `vitest` 4 → 5 (required by `@effect/vitest` rc),
     plus `@cloudflare/workers-types`, `@types/*`, `oxlint`, `oxfmt`,
     `ultracite`, `@effect/language-service`. Tinybird and Drizzle packages
     are not bumped; phase 2 deletes them.
   - Check out the matching tags in the vendored clones:
     `.repos/effect` → `effect@4.0.0-rc.118`, `.repos/alchemy` →
     `v2.0.0-beta.79`. (`.repos/` is gitignored plain clones, not subtrees.)
   - Fix breakages from the upgrade in the current code so `tsc`,
     `pnpm check` and the existing integration tests pass before the rework
     starts. This isolates upgrade breakage from rework changes.
   - Check whether `@effect/sql-sqlite-do` (Effect's SQL client for Durable
     Object SQLite, now published) should replace raw `storage.sql` calls in
     the Durable Objects.
1. **Spike.** A throwaway Durable Object under `alchemy dev` proves: alarms
   fire locally, SQLite and alarms survive a dev restart, RPC between the
   Worker and two DO classes works, and how the account id is supplied
   locally. Go/no-go for the design.
2. **Core.** Monitor DO (storage, alarm derivation, check cycle, state
   machine, reset rules), probe, Registry lifecycle, single Worker with the
   monitors API, dev fixtures and `pnpm seed`. Delete D1, engine and
   Tinybird. Unit tests plus integration for the check cycle.
3. **Alerts.** Channels (CRUD + test), notifications, outbox, ordering,
   backoff, slack/discord/webhook/ntfy.
4. **History.** Counted samples, expected tracking, rollups with watermark,
   retention, checks/uptime/incidents endpoints.
5. **Watchdog** and reconciliation.
6. **UI.** Login, dashboard, monitor detail/forms, channels page, status
   page.
7. **Config as code** (`kanshi sync`), README with a 3-step setup, update
   `AGENTS.md`.

## Risks

- Alchemy is beta; the spike must prove Durable Object alarms and local dev
  before anything is built on them.
- Monitor ↔ Registry calls are not transactional; convergence relies on
  lifecycle states, revision-checked summaries, idempotent operations and
  the watchdog. With the hourly watchdog, a lost status push can leave the
  Registry's cached status (list, status page) behind for up to an hour
  unless the next check retries it; the dashboard reads status live.
- Registry is a single object; fine for up to a few hundred monitors, the
  target scale.
