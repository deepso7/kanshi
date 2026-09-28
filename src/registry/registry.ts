import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ChannelTarget, ChannelView } from "../domain/channel.ts";
import { ChannelKind, maskUrl } from "../domain/channel.ts";
import { MonitorStatus } from "../domain/monitor.ts";
import type { ChannelSelection, MonitorSummary } from "../domain/monitor.ts";
import { openDurableSql } from "../storage/sqlite.ts";
import { KeyTaken, QuotaExceeded, registryErrors } from "./errors.ts";

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
  lastCheckedAt: Schema.NullOr(Schema.Number),
  lifecycle: Lifecycle,
  managed: Schema.BooleanFromBit,
  name: Schema.String,
  opId: Schema.String,
  public: Schema.BooleanFromBit,
  status: MonitorStatus,
  summaryRevision: Schema.Number,
  updatedAt: Schema.Number,
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
}

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
  readonly detail: unknown;
  readonly id: number;
  readonly kind: string;
}

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
    /** `creating` -> `active`, only for the operation that began it. */
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
      detail: unknown
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
    lastCheckedAt: row.lastCheckedAt,
    name: row.name,
    status: row.status,
  },
  summaryRevision: row.summaryRevision,
  updatedAt: row.updatedAt,
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
                lastCheckedAt: input.summary.lastCheckedAt,
                lifecycle: "creating",
                managed: input.managed ? 1 : 0,
                name: input.summary.name,
                opId,
                public: input.public ? 1 : 0,
                status: input.summary.status,
                summaryRevision: 0,
                updatedAt: now,
              })}`;
              return { opId };
            })
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));

      const activate = (id: string, opId: string) =>
        sql<{ id: string }>`UPDATE monitors
          SET lifecycle = 'active', updated_at = ${Date.now()}
          WHERE id = ${id} AND lifecycle = 'creating' AND op_id = ${opId}
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
              last_checked_at = ${summary.lastCheckedAt},
              interval_seconds = ${summary.intervalSeconds},
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

      return {
        activate,
        begin,
        bumpDevCounter: (name: string) =>
          sql<{ value: number }>`INSERT INTO dev_counters (name, value)
            VALUES (${name}, 1)
            ON CONFLICT (name) DO UPDATE SET value = value + 1
            RETURNING value`.pipe(
            Effect.map((rows) => rows[0]?.value ?? 0),
            Effect.orDie
          ),
        channelTarget: (id: string) =>
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
          ),
        createChannel,
        deleteChannel: (id: string) =>
          sql<{
            id: string;
          }>`DELETE FROM channels WHERE id = ${id} RETURNING id`.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.orDie
          ),
        devEvents: () =>
          sql<{
            at: number;
            detail: string;
            id: number;
            kind: string;
          }>`SELECT * FROM dev_events ORDER BY id`.pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                ...row,
                detail: JSON.parse(row.detail) as unknown,
              }))
            ),
            Effect.orDie
          ),
        get,
        getFlip: (name: string) =>
          sql<{
            up: number;
          }>`SELECT up FROM dev_flips WHERE name = ${name}`.pipe(
            // Flip targets start up.
            Effect.map((rows) => (rows[0]?.up ?? 1) === 1),
            Effect.orDie
          ),
        list: () =>
          sql`SELECT * FROM monitors ORDER BY created_at, id`.pipe(
            Effect.flatMap(decodeEntries),
            Effect.orDie
          ),
        listChannels: () =>
          channelRows(sql`SELECT * FROM channels ORDER BY created_at, id`).pipe(
            Effect.map((rows) => rows.map(toChannelView))
          ),
        markDeleting,
        missingChannels: (ids: readonly string[]) =>
          recipients(ids).pipe(
            Effect.map((found) => {
              const existing = new Set(found);
              return [...new Set(ids)].filter((id) => !existing.has(id));
            })
          ),
        recipients,
        recordDevEvent: (kind: string, detail: unknown) =>
          sql<{ id: number }>`INSERT INTO dev_events (at, kind, detail)
            VALUES (${Date.now()}, ${kind}, ${JSON.stringify(detail)})
            RETURNING id`.pipe(
            Effect.map((rows) => rows[0]?.id ?? 0),
            Effect.orDie
          ),
        remove: (id: string) =>
          sql`DELETE FROM monitors WHERE id = ${id}`.pipe(
            Effect.asVoid,
            Effect.orDie
          ),
        setFlip,
        setPublic: (id: string, isPublic: boolean) =>
          sql<{ id: string }>`UPDATE monitors
            SET public = ${isPublic ? 1 : 0}, updated_at = ${Date.now()}
            WHERE id = ${id} AND lifecycle != 'deleting'
            RETURNING id`.pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.orDie
          ),
        updateChannel,
        upsertSummary,
      };
    });
  })
);
