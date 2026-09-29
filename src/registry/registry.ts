import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { DeliveryResult, deliver } from "../alerts/delivery.ts";
import type { WatchdogMessageTag } from "../alerts/message.ts";
import {
  alertRequest,
  idempotencyKey,
  watchdogMessage,
} from "../alerts/message.ts";
import type { OutboxEntry } from "../domain/alert.ts";
import type { ChannelTarget, ChannelView } from "../domain/channel.ts";
import { ChannelKind, maskUrl } from "../domain/channel.ts";
import { MonitorStatus } from "../domain/monitor.ts";
import type { ChannelSelection, MonitorSummary } from "../domain/monitor.ts";
import type { Episode } from "../domain/watchdog.ts";
import {
  OutboxDecision,
  afterAttempt,
  deliverDue,
  dueOutbox,
  outboxDecision,
  outboxDueAt,
  skipped,
} from "../monitor/outbox.ts";
import { openDurableSql } from "../storage/sqlite.ts";
import type { ReconcileItem } from "../watchdog/rules.ts";
import { episodeRetentionMs } from "../watchdog/rules.ts";
import { KeyTaken, QuotaExceeded, registryErrors } from "./errors.ts";
import type { ObserveResult } from "./watchdog-store.ts";
import {
  closeMonitorEpisode,
  observeMonitor,
  pruneEpisodes,
  readEpisode,
  readOpenEpisodes,
  readWatchdogPair,
  readWatchdogWork,
  recentWatchdogAlerts,
  watchdogMigration,
  writeWatchdogOutbox,
} from "./watchdog-store.ts";

/** The singleton Registry object's name. */
export const registryName = "registry";

export const Lifecycle = Schema.Literals(["creating", "active", "deleting"]);
export type Lifecycle = typeof Lifecycle.Type;

const EntryRow = Schema.Struct({
  createdAt: Schema.Number,
  enabled: Schema.BooleanFromBit,
  id: Schema.String,
  intervalSeconds: Schema.Number,
  key: Schema.String,
  lifecycle: Lifecycle,
  managed: Schema.BooleanFromBit,
  name: Schema.String,
  opId: Schema.String,
  public: Schema.BooleanFromBit,
  staleEpisodeId: Schema.NullOr(Schema.String),
  status: MonitorStatus,
  summaryRevision: Schema.Number,
  updatedAt: Schema.Number,
  url: Schema.String,
});

export interface RegistryEntry {
  readonly createdAt: number;
  readonly id: string;
  readonly key: string;
  readonly lifecycle: Lifecycle;
  readonly managed: boolean;
  readonly opId: string;
  readonly public: boolean;
  readonly summary: MonitorSummary;
  readonly summaryRevision: number;
  readonly updatedAt: number;
  /** The watchdog's open "not being checked" episode. */
  readonly watch: {
    readonly episodeId: string | null;
  };
}

/** What the watchdog's batched `reconcile` did with one monitor. */
export interface ReconcileResult {
  /** Why the item failed (its transaction rolled back), or null. */
  readonly error: string | null;
  readonly id: string;
  readonly summaryUpdated: boolean;
  readonly watch: ObserveResult | null;
}

/** The watchdog's one Registry write per run. */
export interface ReconcileReport {
  /** The Registry alarm after the run: set only when alerts are due. */
  readonly alarmAt: number | null;
  /** Resolved episodes pruned, or null if pruning failed. */
  readonly pruned: number | null;
  readonly results: readonly ReconcileResult[];
}

/** Dev stage: Registry calls per method since this instance started. */
export interface RegistryCalls {
  readonly counts: Readonly<Record<string, number>>;
  /** Changes when the object is evicted and started again. */
  readonly instanceId: string;
  readonly startedAt: number;
}

/** Watchdog episodes and their alert rows, for the dev inspector. */
export interface WatchdogAlertsView {
  readonly episodes: readonly Episode[];
  readonly outbox: readonly OutboxEntry[];
}

/** The watchdog message for an outbox decision about an episode. */
const watchdogTag: Record<
  "Down" | "DownRecovered" | "Recovered",
  WatchdogMessageTag
> = {
  Down: "NotChecked",
  DownRecovered: "NotCheckedResolved",
  Recovered: "CheckedAgain",
};

export interface BeginInput {
  readonly id: string;
  readonly key: string;
  readonly managed: boolean;
  readonly public: boolean;
  readonly quota: number;
  readonly summary: MonitorSummary;
}

/** A channel as stored, including its secret URL and the URL's hash. */
export interface ChannelRecord {
  readonly id: string;
  readonly key: string;
  readonly kind: ChannelKind;
  readonly managed: boolean;
  readonly name: string;
  readonly url: string;
  readonly urlHash: string;
}

export type ChannelRecordPatch = Partial<
  Pick<ChannelRecord, "kind" | "managed" | "name" | "url" | "urlHash">
>;

const ChannelRow = Schema.Struct({
  createdAt: Schema.Number,
  id: Schema.String,
  key: Schema.String,
  kind: ChannelKind,
  managed: Schema.BooleanFromBit,
  name: Schema.String,
  updatedAt: Schema.Number,
  url: Schema.String,
  urlHash: Schema.String,
});
type ChannelRow = typeof ChannelRow.Type;

const toChannelView = (row: ChannelRow): ChannelView => ({
  createdAt: row.createdAt,
  id: row.id,
  key: row.key,
  kind: row.kind,
  managed: row.managed,
  maskedUrl: maskUrl(row.url),
  name: row.name,
  updatedAt: row.updatedAt,
  urlHash: row.urlHash,
});

const decodeChannels = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(ChannelRow))(rows).pipe(Effect.orDie);

const channelRows = (rows: Effect.Effect<readonly unknown[], unknown>) =>
  rows.pipe(Effect.orDie, Effect.flatMap(decodeChannels));

export interface DevEvent {
  readonly at: number;
  readonly detail: Schema.Json;
  readonly id: number;
  readonly kind: string;
}

/** `dev_events` rows; `detail` is stored as JSON text. */
const DevEventRows = Schema.Array(
  Schema.Struct({
    at: Schema.Number,
    detail: Schema.fromJsonString(Schema.Json),
    id: Schema.Number,
    kind: Schema.String,
  })
);

const noWatchdogWork: readonly OutboxEntry[] = [];

export class Registry extends Cloudflare.DurableObject<
  Registry,
  {
    /** Insert a `creating` row with a fresh opId (quota and unique key). */
    begin: (
      input: BeginInput
    ) => Effect.Effect<
      { readonly opId: string },
      KeyTaken | QuotaExceeded,
      RuntimeContext
    >;
    /**
     * `creating` -> `active`, only for the operation that began it.
     * Idempotent: true if that operation's row is already active.
     */
    activate: (
      id: string,
      opId: string
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    /**
     * Mark a row `deleting`. With an `opId`, only a `creating` row of that
     * operation is marked (watchdog cleanup of an abandoned create).
     */
    markDeleting: (
      id: string,
      opId: string | null
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    remove: (id: string) => Effect.Effect<void, never, RuntimeContext>;
    get: (
      id: string
    ) => Effect.Effect<RegistryEntry | null, never, RuntimeContext>;
    list: () => Effect.Effect<readonly RegistryEntry[], never, RuntimeContext>;
    setPublic: (
      id: string,
      isPublic: boolean
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    /** Mirror the monitor's `managed` flag (config sync adopts monitors). */
    setManaged: (
      id: string,
      managed: boolean
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    /**
     * Store a monitor's summary unless the row is missing or `deleting`, or
     * `revision` is not newer than the stored one.
     */
    upsertSummary: (
      id: string,
      summary: MonitorSummary,
      revision: number
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    recordDevEvent: (
      kind: string,
      detail: Schema.Json
    ) => Effect.Effect<number, never, RuntimeContext>;
    devEvents: () => Effect.Effect<readonly DevEvent[], never, RuntimeContext>;
    /** Set a dev flip target up/down, or toggle it when `up` is null. */
    setFlip: (
      name: string,
      up: boolean | null
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    getFlip: (name: string) => Effect.Effect<boolean, never, RuntimeContext>;
    /** Dev stage: increment and return a named counter (starts at 1). */
    bumpDevCounter: (
      name: string
    ) => Effect.Effect<number, never, RuntimeContext>;
    /** Insert a channel (unique key). */
    createChannel: (
      record: ChannelRecord
    ) => Effect.Effect<ChannelView, KeyTaken, RuntimeContext>;
    updateChannel: (
      id: string,
      patch: ChannelRecordPatch
    ) => Effect.Effect<ChannelView | null, never, RuntimeContext>;
    deleteChannel: (
      id: string
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    listChannels: () => Effect.Effect<
      readonly ChannelView[],
      never,
      RuntimeContext
    >;
    /** The channel with its secret URL, for delivery. Null once deleted. */
    channelTarget: (
      id: string
    ) => Effect.Effect<ChannelTarget | null, never, RuntimeContext>;
    /**
     * The ids of the existing channels a monitor alerts: every channel for
     * `all`, otherwise the listed ones that still exist.
     */
    recipients: (
      selection: ChannelSelection
    ) => Effect.Effect<readonly string[], never, RuntimeContext>;
    /** The given ids that name no channel. */
    missingChannels: (
      ids: readonly string[]
    ) => Effect.Effect<readonly string[], never, RuntimeContext>;
    /**
     * The watchdog's one write per run, for every active monitor it read:
     * store the summary (same revision rule as `upsertSummary`, so a lost
     * push converges and a newer one is never overwritten) and record the
     * observation, opening (alerting every channel), resolving or closing
     * its "not being checked" episode. Then prune old episodes and re-arm
     * the alarm, which is set only while watchdog alerts are due. `at` is
     * the run's clock. Each item is its own transaction.
     */
    reconcile: (
      items: readonly ReconcileItem[],
      at: number
    ) => Effect.Effect<ReconcileReport, never, RuntimeContext>;
    /** The open "not being checked" episodes, oldest first. */
    openEpisodes: () => Effect.Effect<
      readonly Episode[],
      never,
      RuntimeContext
    >;
    watchdogAlerts: (
      limit: number
    ) => Effect.Effect<WatchdogAlertsView, never, RuntimeContext>;
    /**
     * Dev inspection: calls per method (every RPC and the alarm) since
     * this instance started, counted in memory. Not counted itself.
     */
    devCalls: () => Effect.Effect<RegistryCalls, never, RuntimeContext>;
    /**
     * Dev stage: forget a monitor's summary (name "(stale)", status
     * unknown, no URL, revision 0), as if every push had been lost (or the
     * row predates migration 4).
     */
    devRewindSummary: (
      id: string
    ) => Effect.Effect<boolean, never, RuntimeContext>;
    /** Delivers the watchdog's alerts; re-armed from the outbox. */
    alarm: (
      info?: Cloudflare.AlarmInvocationInfo
    ) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("Registry", { errors: registryErrors }) {}

const migrations = SqliteMigrator.fromRecord({
  "1_core": Effect.gen(function* coreMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE monitors (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      managed INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      op_id TEXT NOT NULL,
      public INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      last_checked_at INTEGER,
      interval_seconds INTEGER NOT NULL,
      summary_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // Dev stage only: webhook sink events and flip targets.
    yield* sql`CREATE TABLE dev_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE dev_flips (
      name TEXT PRIMARY KEY,
      up INTEGER NOT NULL
    )`;
  }),
  "2_channels": Effect.gen(function* channelsMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      managed INTEGER NOT NULL,
      kind TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    // Dev stage only: counters for the webhook sink's `failTimes`.
    yield* sql`CREATE TABLE dev_counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`;
  }),
  "3_watchdog": watchdogMigration,
  // The summary gains the target URL. Revision 0 lets the next summary
  // push (a check, an edit or the watchdog's refresh) fill it in.
  "4_monitor_url": Effect.gen(function* monitorUrlMigration() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE monitors ADD COLUMN url TEXT NOT NULL DEFAULT ''`;
    yield* sql`UPDATE monitors SET summary_revision = 0`;
  }),
  // Monitors push their summary only when a Registry-visible field
  // changes, not after every check, so the summary no longer carries the
  // last check time (the dashboard reads it live from each monitor).
  "5_summary_without_last_checked": Effect.gen(
    function* summaryWithoutLastCheckedMigration() {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE monitors DROP COLUMN last_checked_at`;
    }
  ),
  // The hourly watchdog opens an episode on one stale observation, so the
  // consecutive-stale-runs counter is gone (`stale_episode_id` stays).
  "6_watchdog_single_observation": Effect.gen(
    function* watchdogSingleObservationMigration() {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE monitors DROP COLUMN stale_runs`;
    }
  ),
});

const toEntry = (row: typeof EntryRow.Type): RegistryEntry => ({
  createdAt: row.createdAt,
  id: row.id,
  key: row.key,
  lifecycle: row.lifecycle,
  managed: row.managed,
  opId: row.opId,
  public: row.public,
  summary: {
    enabled: row.enabled,
    intervalSeconds: row.intervalSeconds,
    name: row.name,
    status: row.status,
    url: row.url,
  },
  summaryRevision: row.summaryRevision,
  updatedAt: row.updatedAt,
  watch: { episodeId: row.staleEpisodeId },
});

const decodeEntries = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(EntryRow))(rows).pipe(
    Effect.map((decoded) => decoded.map(toEntry))
  );

export const RegistryLive = Registry.make(
  Effect.gen(function* RegistryInit() {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* RegistryInstance() {
      const sql = yield* openDurableSql(state, migrations);
      // Serialises alarm updates so the last one written is computed from
      // the latest committed state.
      const alarmLock = yield* Semaphore.make(1);

      const withSql = <A, E>(
        effect: Effect.Effect<A, E, SqlClient.SqlClient>
      ) => Effect.provideService(effect, SqlClient.SqlClient, sql);
      /** Run `effect` in one storage transaction; SQL errors are defects. */
      const transact = <A, E>(
        effect: Effect.Effect<A, E, SqlClient.SqlClient>
      ) =>
        withSql(sql.withTransaction(effect)).pipe(
          Effect.catchTag("SqlError", Effect.die)
        );

      /** The alarm is due when the earliest sendable watchdog alert is. */
      const rearm = alarmLock
        .withPermits(1)(
          Effect.gen(function* rearmEffect() {
            const work = yield* withSql(readWatchdogWork);
            const at = outboxDueAt(work);
            yield* at === null
              ? state.storage.deleteAlarm()
              : state.storage.setAlarm(at);
            return at;
          })
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to set the registry alarm", cause).pipe(
              Effect.as(null)
            )
          )
        );

      const get = (id: string) =>
        sql`SELECT * FROM monitors WHERE id = ${id}`.pipe(
          Effect.flatMap(decodeEntries),
          Effect.map((entries) => entries[0] ?? null),
          Effect.orDie
        );

      const begin = (input: BeginInput) =>
        sql
          .withTransaction(
            Effect.gen(function* beginTx() {
              const [count] = yield* sql<{
                n: number;
              }>`SELECT count(*) AS n FROM monitors`;
              if ((count?.n ?? 0) >= input.quota) {
                return yield* new QuotaExceeded({ quota: input.quota });
              }
              const taken =
                yield* sql`SELECT id FROM monitors WHERE key = ${input.key}`;
              if (taken.length > 0) {
                return yield* new KeyTaken({ key: input.key });
              }
              const opId = crypto.randomUUID();
              const now = Date.now();
              yield* sql`INSERT INTO monitors ${sql.insert({
                createdAt: now,
                enabled: input.summary.enabled ? 1 : 0,
                id: input.id,
                intervalSeconds: input.summary.intervalSeconds,
                key: input.key,
                lifecycle: "creating",
                managed: input.managed ? 1 : 0,
                name: input.summary.name,
                opId,
                public: input.public ? 1 : 0,
                status: input.summary.status,
                summaryRevision: 0,
                updatedAt: now,
                url: input.summary.url,
              })}`;
              return { opId };
            })
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));

      const activate = (id: string, opId: string) =>
        sql<{ id: string }>`UPDATE monitors
          SET lifecycle = 'active',
              updated_at = CASE lifecycle
                WHEN 'creating' THEN ${Date.now()} ELSE updated_at END
          WHERE id = ${id}
            AND lifecycle IN ('creating', 'active')
            AND op_id = ${opId}
          RETURNING id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        );

      const markDeleting = (id: string, opId: string | null) =>
        (opId === null
          ? sql<{ id: string }>`UPDATE monitors
              SET lifecycle = 'deleting', updated_at = ${Date.now()}
              WHERE id = ${id}
              RETURNING id`
          : sql<{ id: string }>`UPDATE monitors
              SET lifecycle = 'deleting', updated_at = ${Date.now()}
              WHERE id = ${id} AND lifecycle = 'creating' AND op_id = ${opId}
              RETURNING id`
        ).pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        );

      const upsertSummary = (
        id: string,
        summary: MonitorSummary,
        revision: number
      ) =>
        sql<{ id: string }>`UPDATE monitors
          SET name = ${summary.name},
              status = ${summary.status},
              enabled = ${summary.enabled ? 1 : 0},
              interval_seconds = ${summary.intervalSeconds},
              url = ${summary.url},
              summary_revision = ${revision},
              updated_at = ${Date.now()}
          WHERE id = ${id}
            AND lifecycle != 'deleting'
            AND summary_revision < ${revision}
          RETURNING id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        );

      const setFlip = (name: string, up: boolean | null) => {
        let next = sql.literal("1 - up");
        if (up !== null) {
          next = sql.literal(up ? "1" : "0");
        }
        return sql<{ up: number }>`INSERT INTO dev_flips (name, up)
          VALUES (${name}, ${up === false ? 0 : 1})
          ON CONFLICT (name) DO UPDATE SET up = ${next}
          RETURNING up`.pipe(
          Effect.map((rows) => rows[0]?.up === 1),
          Effect.orDie
        );
      };

      const getChannel = (id: string) =>
        channelRows(sql`SELECT * FROM channels WHERE id = ${id}`).pipe(
          Effect.map((rows) => rows[0] ?? null)
        );

      const createChannel = (record: ChannelRecord) =>
        sql
          .withTransaction(
            Effect.gen(function* createChannelTx() {
              const taken =
                yield* sql`SELECT id FROM channels WHERE key = ${record.key}`;
              if (taken.length > 0) {
                return yield* new KeyTaken({ key: record.key });
              }
              const now = Date.now();
              const rows = yield* sql`INSERT INTO channels ${sql.insert({
                createdAt: now,
                id: record.id,
                key: record.key,
                kind: record.kind,
                managed: record.managed ? 1 : 0,
                name: record.name,
                updatedAt: now,
                url: record.url,
                urlHash: record.urlHash,
              })} RETURNING *`;
              const [row] = yield* decodeChannels(rows);
              if (row === undefined) {
                return yield* Effect.die("channel insert returned no row");
              }
              return toChannelView(row);
            })
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));

      const updateChannel = (id: string, patch: ChannelRecordPatch) =>
        Effect.gen(function* updateChannelEffect() {
          const current = yield* getChannel(id);
          if (current === null) {
            return null;
          }
          const rows = yield* channelRows(sql`UPDATE channels
            SET kind = ${patch.kind ?? current.kind},
                managed = ${(patch.managed ?? current.managed) ? 1 : 0},
                name = ${patch.name ?? current.name},
                url = ${patch.url ?? current.url},
                url_hash = ${patch.urlHash ?? current.urlHash},
                updated_at = ${Date.now()}
            WHERE id = ${id}
            RETURNING *`);
          const [row] = rows;
          return row === undefined ? null : toChannelView(row);
        });

      const recipients = (selection: ChannelSelection) =>
        sql<{
          id: string;
        }>`SELECT id FROM channels ORDER BY created_at, id`.pipe(
          Effect.map((rows) => {
            const existing = rows.map((row) => row.id);
            if (selection === "all") {
              return existing;
            }
            const wanted = new Set(selection);
            return existing.filter((id) => wanted.has(id));
          }),
          Effect.orDie
        );

      /** Decide, and possibly send, one watchdog alert row. */
      const sendOne = (due: OutboxEntry) =>
        Effect.gen(function* sendOneEffect() {
          const pair = yield* withSql(
            readWatchdogPair(due.incidentId, due.event, due.channelId)
          );
          const { entry } = pair;
          if (entry === null) {
            return;
          }
          const episode = yield* withSql(readEpisode(entry.incidentId));
          const decision = outboxDecision(entry, pair.down, episode);
          if (
            OutboxDecision.$is("Done")(decision) ||
            OutboxDecision.$is("Wait")(decision)
          ) {
            return;
          }
          if (!OutboxDecision.$is("Send")(decision) || episode === null) {
            const reason = OutboxDecision.$is("Skip")(decision)
              ? decision.reason
              : "episode no longer exists";
            yield* transact(
              writeWatchdogOutbox(skipped(entry, reason, Date.now()))
            );
            return;
          }
          const target = yield* getChannel(entry.channelId);
          if (target === null) {
            const gone = DeliveryResult.Failed({
              error: "channel deleted",
              permanent: true,
              status: null,
            });
            yield* transact(
              writeWatchdogOutbox(afterAttempt(entry, gone, false, Date.now()))
            );
            return;
          }
          const result = yield* deliver(
            alertRequest(
              target.kind,
              target.url,
              watchdogMessage(watchdogTag[decision.message], {
                episode: {
                  id: episode.id,
                  intervalSeconds: episode.intervalSeconds,
                  lastCheckedAt: episode.lastCheckedAt,
                  resolvedAt: episode.resolvedAt,
                  startedAt: episode.startedAt,
                },
                idempotencyKey: idempotencyKey(
                  entry.incidentId,
                  entry.event,
                  entry.channelId
                ),
                monitor: {
                  id: episode.monitorId,
                  name: episode.monitorName,
                  url: episode.monitorUrl,
                },
                sentAt: Date.now(),
              })
            )
          );
          if (DeliveryResult.$is("Failed")(result)) {
            yield* Effect.logWarning(
              `watchdog alert ${entry.incidentId}:${entry.event} to ${entry.channelId} failed: ${result.error}`
            );
          }
          yield* transact(
            writeWatchdogOutbox(
              afterAttempt(
                entry,
                result,
                decision.message === "DownRecovered",
                Date.now()
              )
            )
          );
        });

      const alarm = (_info?: Cloudflare.AlarmInvocationInfo) =>
        Effect.gen(function* alarmEffect() {
          const work = yield* withSql(readWatchdogWork).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("reading watchdog alerts failed", cause).pipe(
                Effect.as(noWatchdogWork)
              )
            )
          );
          // Bounded like the Monitor's outbox: rows left over stay due and
          // the alarm re-arms for them at once.
          yield* deliverDue(dueOutbox(work, Date.now()), (entry) =>
            sendOne(entry).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(
                  `watchdog alert ${entry.incidentId}:${entry.event} failed`,
                  cause
                )
              )
            )
          );
          yield* rearm;
        }).pipe(Effect.withSpan("Registry.alarm"));

      /** One item of `reconcile`: summary, then episode, in one transaction. */
      const reconcileOne = (item: ReconcileItem, at: number) =>
        transact(
          Effect.gen(function* reconcileOneTx() {
            const summaryUpdated = yield* upsertSummary(
              item.id,
              item.summary,
              item.revision
            );
            const watch = yield* observeMonitor(
              item.id,
              item.observation,
              at,
              Date.now()
            );
            return { summaryUpdated, watch };
          })
        ).pipe(
          Effect.tap(({ watch }) =>
            watch.change === "open"
              ? Effect.logWarning(
                  `monitor ${item.observation.name} (${item.id}) is not being checked`
                )
              : Effect.void
          ),
          Effect.map(({ summaryUpdated, watch }): ReconcileResult => ({
            error: null,
            id: item.id,
            summaryUpdated,
            watch,
          })),
          Effect.catchCause((cause) =>
            Effect.logError(
              `watchdog reconcile of ${item.id} failed`,
              cause
            ).pipe(
              Effect.as({
                error: Cause.pretty(cause).split("\n", 1)[0] ?? "failed",
                id: item.id,
                summaryUpdated: false,
                watch: null,
              } satisfies ReconcileResult)
            )
          )
        );

      const reconcile = (items: readonly ReconcileItem[], at: number) =>
        Effect.gen(function* reconcileEffect() {
          // One item after another: each is a storage transaction.
          const results = yield* Effect.forEach(
            items,
            (item) => reconcileOne(item, at),
            { concurrency: 1 }
          );
          const pruned = yield* transact(
            pruneEpisodes(at - episodeRetentionMs)
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("pruning watchdog episodes failed", cause).pipe(
                Effect.as(null)
              )
            )
          );
          const alarmAt = yield* rearm;
          return { alarmAt, pruned, results } satisfies ReconcileReport;
        }).pipe(Effect.withSpan("Registry.reconcile"));

      // Dev inspection: calls per method, in memory (see `devCalls`).
      const instanceId = crypto.randomUUID();
      const startedAt = Date.now();
      const calls = new Map<string, number>();
      /** `method`, counting each call under `name`. */
      const counted =
        <Args extends readonly unknown[], A, E, R>(
          name: string,
          method: (...args: Args) => Effect.Effect<A, E, R>
        ) =>
        (...args: Args) => {
          calls.set(name, (calls.get(name) ?? 0) + 1);
          return method(...args);
        };

      return {
        activate: counted("activate", activate),
        alarm: counted("alarm", alarm),
        begin: counted("begin", begin),
        bumpDevCounter: counted("bumpDevCounter", (name: string) =>
          sql<{ value: number }>`INSERT INTO dev_counters (name, value)
            VALUES (${name}, 1)
            ON CONFLICT (name) DO UPDATE SET value = value + 1
            RETURNING value`.pipe(
            Effect.map((rows) => rows[0]?.value ?? 0),
            Effect.orDie
          )
        ),
        channelTarget: counted("channelTarget", (id: string) =>
          getChannel(id).pipe(
            Effect.map((row) =>
              row === null
                ? null
                : ({
                    id: row.id,
                    kind: row.kind,
                    name: row.name,
                    url: row.url,
                  } satisfies ChannelTarget)
            )
          )
        ),
        createChannel: counted("createChannel", createChannel),
        deleteChannel: counted("deleteChannel", (id: string) =>
          sql<{
            id: string;
          }>`DELETE FROM channels WHERE id = ${id} RETURNING id`.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.orDie
          )
        ),
        devCalls: () =>
          Effect.sync((): RegistryCalls => ({
            counts: Object.fromEntries(calls),
            instanceId,
            startedAt,
          })),
        devEvents: counted("devEvents", () =>
          sql`SELECT * FROM dev_events ORDER BY id`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DevEventRows)),
            Effect.orDie
          )
        ),
        devRewindSummary: counted("devRewindSummary", (id: string) =>
          sql<{ id: string }>`UPDATE monitors
            SET name = '(stale)', status = 'unknown', url = '',
                summary_revision = 0, updated_at = ${Date.now()}
            WHERE id = ${id}
            RETURNING id`.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.orDie
          )
        ),
        get: counted("get", get),
        getFlip: counted("getFlip", (name: string) =>
          sql<{
            up: number;
          }>`SELECT up FROM dev_flips WHERE name = ${name}`.pipe(
            // Flip targets start up.
            Effect.map((rows) => (rows[0]?.up ?? 1) === 1),
            Effect.orDie
          )
        ),
        list: counted("list", () =>
          sql`SELECT * FROM monitors ORDER BY created_at, id`.pipe(
            Effect.flatMap(decodeEntries),
            Effect.orDie
          )
        ),
        listChannels: counted("listChannels", () =>
          channelRows(sql`SELECT * FROM channels ORDER BY created_at, id`).pipe(
            Effect.map((rows) => rows.map(toChannelView))
          )
        ),
        markDeleting: counted("markDeleting", markDeleting),
        missingChannels: counted("missingChannels", (ids: readonly string[]) =>
          recipients(ids).pipe(
            Effect.map((found) => {
              const existing = new Set(found);
              return [...new Set(ids)].filter((id) => !existing.has(id));
            })
          )
        ),
        openEpisodes: counted("openEpisodes", () =>
          withSql(readOpenEpisodes).pipe(Effect.orDie)
        ),
        recipients: counted("recipients", recipients),
        reconcile: counted("reconcile", reconcile),
        recordDevEvent: counted(
          "recordDevEvent",
          (kind: string, detail: Schema.Json) =>
            sql<{ id: number }>`INSERT INTO dev_events (at, kind, detail)
            VALUES (${Date.now()}, ${kind}, ${JSON.stringify(detail)})
            RETURNING id`.pipe(
              Effect.map((rows) => rows[0]?.id ?? 0),
              Effect.orDie
            )
        ),
        remove: counted("remove", (id: string) =>
          transact(
            Effect.gen(function* removeTx() {
              yield* closeMonitorEpisode(id, Date.now());
              yield* sql`DELETE FROM monitors WHERE id = ${id}`;
            })
          ).pipe(Effect.andThen(rearm), Effect.asVoid)
        ),
        setFlip: counted("setFlip", setFlip),
        setManaged: counted("setManaged", (id: string, managed: boolean) =>
          sql<{ id: string }>`UPDATE monitors
            SET managed = ${managed ? 1 : 0}, updated_at = ${Date.now()}
            WHERE id = ${id} AND lifecycle != 'deleting'
            RETURNING id`.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.orDie
          )
        ),
        setPublic: counted("setPublic", (id: string, isPublic: boolean) =>
          sql<{ id: string }>`UPDATE monitors
            SET public = ${isPublic ? 1 : 0}, updated_at = ${Date.now()}
            WHERE id = ${id} AND lifecycle != 'deleting'
            RETURNING id`.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.orDie
          )
        ),
        updateChannel: counted("updateChannel", updateChannel),
        upsertSummary: counted("upsertSummary", upsertSummary),
        watchdogAlerts: counted("watchdogAlerts", (limit: number) =>
          withSql(recentWatchdogAlerts(limit)).pipe(Effect.orDie)
        ),
      };
    });
  })
);
