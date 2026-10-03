import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { AlertEvent } from "../domain/alert.ts";
import { OutboxEntry } from "../domain/alert.ts";
import type { IncidentResolution } from "../domain/monitor.ts";
import { Episode } from "../domain/watchdog.ts";
import type { ReconcileItem, WatchChange } from "../watchdog/rules.ts";
import { watchOutcome } from "../watchdog/rules.ts";

/**
 * Registry storage for the watchdog: the per-monitor open episode (a column
 * on `monitors`), "not being checked" episodes and their alert outbox. The
 * outbox has the Monitor's outbox shape (`incident_id` holds the episode
 * id), so the same pure ordering and retry rules apply.
 */

const OutboxRow = Schema.Struct({
  ...OutboxEntry.fields,
  combined: Schema.BooleanFromBit,
});

/** The `monitors` columns an observation is checked against. */
const WatchedRows = Schema.Array(
  Schema.Struct({
    lifecycle: Schema.Literals(["creating", "active", "deleting"]),
    staleEpisodeId: Schema.NullOr(Schema.String),
    summaryRevision: Schema.Number,
  })
);

const decodeOutbox = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(OutboxRow))(rows).pipe(Effect.orDie);

const decodeEpisodes = (rows: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(Episode))(rows).pipe(Effect.orDie);

/** Migration `3_watchdog` (applied; `stale_runs` is dropped by `6_...`). */
export const watchdogMigration = Effect.gen(function* watchdogMigration() {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE monitors ADD COLUMN stale_runs INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE monitors ADD COLUMN stale_episode_id TEXT`;
  yield* sql`CREATE TABLE watchdog_episodes (
    id TEXT PRIMARY KEY,
    monitor_id TEXT NOT NULL,
    monitor_name TEXT NOT NULL,
    monitor_url TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    last_checked_at INTEGER,
    started_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolution TEXT
  )`;
  yield* sql`CREATE INDEX watchdog_episodes_resolved_at
    ON watchdog_episodes (resolved_at)`;
  yield* sql`CREATE TABLE watchdog_outbox (
    incident_id TEXT NOT NULL,
    event TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    combined INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (incident_id, event, channel_id)
  )`;
  yield* sql`CREATE INDEX watchdog_outbox_state ON watchdog_outbox (state)`;
});

const queueRow = (
  episodeId: string,
  event: AlertEvent,
  channelId: string,
  now: number
) =>
  Schema.encodeSync(OutboxRow)({
    attempts: 0,
    channelId,
    combined: false,
    createdAt: now,
    event,
    incidentId: episodeId,
    lastError: null,
    nextAttemptAt: now,
    state: "pending",
    updatedAt: now,
  });

const closeEpisode = Effect.fn("WatchdogStore.closeEpisode")(
  function* closeEpisodeEffect(
    episodeId: string,
    resolution: IncidentResolution,
    at: number
  ) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE watchdog_episodes
      SET resolved_at = ${at}, resolution = ${resolution}
      WHERE id = ${episodeId} AND resolved_at IS NULL`;
  }
);

export interface ObserveResult {
  /**
   * False when the observation is out of date: the row is missing, not
   * active, or has a newer summary revision (nothing recorded).
   */
  readonly applied: boolean;
  readonly change: WatchChange;
  readonly episodeId: string | null;
}

/**
 * Record one watchdog observation of an active monitor, in one transaction
 * (the caller's), if it is still current (`watchOutcome`): open, resolve
 * or close its episode. Only a `confirmed` observation opens one; the
 * batch's would-be opens are returned as `suspect` with nothing recorded.
 * Opening queues a `down` row for every channel; resolving queues an `up`
 * row for every channel that got a `down` row. `at` is the watchdog run's
 * clock; queued rows are due at `queuedAt`.
 */
export const observeMonitor = Effect.fn("WatchdogStore.observeMonitor")(
  function* observeMonitorEffect(
    monitorId: string,
    item: Pick<ReconcileItem, "observation" | "revision">,
    at: number,
    queuedAt: number,
    confirmed: boolean
  ) {
    const sql = yield* SqlClient.SqlClient;
    const { observation } = item;
    const [stored] =
      yield* sql`SELECT lifecycle, stale_episode_id, summary_revision
      FROM monitors WHERE id = ${monitorId}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WatchedRows)),
        Effect.orDie
      );
    const row =
      stored === undefined
        ? null
        : {
            episodeId: stored.staleEpisodeId,
            lifecycle: stored.lifecycle,
            summaryRevision: stored.summaryRevision,
          };
    const { applied, change } = watchOutcome(row, item, confirmed);
    if (!applied || row === null) {
      return {
        applied: false,
        change: "none",
        episodeId: null,
      } satisfies ObserveResult;
    }
    let { episodeId } = row;
    switch (change) {
      case "open": {
        episodeId = `watchdog-${crypto.randomUUID()}`;
        yield* sql`INSERT INTO watchdog_episodes ${sql.insert({
          id: episodeId,
          intervalSeconds: observation.intervalSeconds,
          lastCheckedAt: observation.lastCheckedAt,
          monitorId,
          monitorName: observation.name,
          monitorUrl: observation.url,
          resolution: null,
          resolvedAt: null,
          startedAt: at,
        })}`;
        const channels = yield* sql<{
          id: string;
        }>`SELECT id FROM channels ORDER BY created_at, id`;
        for (const channel of channels) {
          yield* sql`INSERT OR IGNORE INTO watchdog_outbox ${sql.insert(
            queueRow(episodeId, "down", channel.id, queuedAt)
          )}`;
        }
        break;
      }
      case "resolve": {
        if (episodeId !== null) {
          yield* closeEpisode(episodeId, "recovered", at);
          const alerted = yield* sql<{
            channelId: string;
          }>`SELECT channel_id FROM watchdog_outbox
            WHERE incident_id = ${episodeId} AND event = 'down'`;
          for (const { channelId } of alerted) {
            yield* sql`INSERT OR IGNORE INTO watchdog_outbox ${sql.insert(
              queueRow(episodeId, "up", channelId, queuedAt)
            )}`;
          }
        }
        episodeId = null;
        break;
      }
      case "close": {
        if (episodeId !== null) {
          yield* closeEpisode(episodeId, "disabled", at);
        }
        episodeId = null;
        break;
      }
      case "none":
      case "suspect": {
        break;
      }
      default: {
        return change satisfies never;
      }
    }
    if (change !== "none" && change !== "suspect") {
      yield* sql`UPDATE monitors SET stale_episode_id = ${episodeId}
        WHERE id = ${monitorId}`;
    }
    return { applied: true, change, episodeId } satisfies ObserveResult;
  }
);

/** The monitor row is going away: its open episode ends as `deleted`. */
export const closeMonitorEpisode = Effect.fn(
  "WatchdogStore.closeMonitorEpisode"
)(function* closeMonitorEpisodeEffect(monitorId: string, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    staleEpisodeId: string | null;
  }>`SELECT stale_episode_id FROM monitors WHERE id = ${monitorId}`;
  if (row?.staleEpisodeId) {
    yield* closeEpisode(row.staleEpisodeId, "deleted", at);
  }
});

/**
 * Pending alert work: every outbox row of an episode that has a pending
 * one (so each pending `up` row comes with its `down` row).
 */
export const readWatchdogWork = Effect.gen(function* readWatchdogWorkEffect() {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM watchdog_outbox
    WHERE incident_id IN (
      SELECT incident_id FROM watchdog_outbox WHERE state = 'pending'
    )`.pipe(Effect.flatMap(decodeOutbox));
});

/** An outbox row and, for an `up` row, its `down` row. */
export const readWatchdogPair = Effect.fn("WatchdogStore.readWatchdogPair")(
  function* readWatchdogPairEffect(
    episodeId: string,
    event: AlertEvent,
    channelId: string
  ) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT * FROM watchdog_outbox
      WHERE incident_id = ${episodeId} AND channel_id = ${channelId}`.pipe(
      Effect.flatMap(decodeOutbox)
    );
    return {
      down: rows.find((row) => row.event === "down") ?? null,
      entry: rows.find((row) => row.event === event) ?? null,
    };
  }
);

export const readEpisode = Effect.fn("WatchdogStore.readEpisode")(
  function* readEpisodeEffect(episodeId: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT * FROM watchdog_episodes
      WHERE id = ${episodeId}`.pipe(Effect.flatMap(decodeEpisodes));
    return rows[0] ?? null;
  }
);

/** Store an attempt's outcome; only a still-pending row is updated. */
export const writeWatchdogOutbox = Effect.fn(
  "WatchdogStore.writeWatchdogOutbox"
)(function* writeWatchdogOutboxEffect(entry: OutboxEntry) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE watchdog_outbox
    SET state = ${entry.state},
        attempts = ${entry.attempts},
        next_attempt_at = ${entry.nextAttemptAt},
        last_error = ${entry.lastError},
        combined = ${entry.combined ? 1 : 0},
        updated_at = ${entry.updatedAt}
    WHERE incident_id = ${entry.incidentId}
      AND event = ${entry.event}
      AND channel_id = ${entry.channelId}
      AND state = 'pending'`;
});

/** The open "not being checked" episodes, oldest first. */
export const readOpenEpisodes = Effect.gen(function* readOpenEpisodesEffect() {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM watchdog_episodes
    WHERE resolved_at IS NULL
    ORDER BY started_at, id`.pipe(Effect.flatMap(decodeEpisodes));
});

/** Recent episodes and their alert rows, newest first. */
export const recentWatchdogAlerts = Effect.fn(
  "WatchdogStore.recentWatchdogAlerts"
)(function* recentWatchdogAlertsEffect(limit: number) {
  const sql = yield* SqlClient.SqlClient;
  const episodes = yield* sql`SELECT * FROM watchdog_episodes
    ORDER BY started_at DESC, id LIMIT ${limit}`.pipe(
    Effect.flatMap(decodeEpisodes)
  );
  const outbox = yield* sql`SELECT * FROM watchdog_outbox
    WHERE incident_id IN (
      SELECT id FROM watchdog_episodes ORDER BY started_at DESC, id LIMIT ${limit}
    )
    ORDER BY created_at DESC, event DESC, channel_id`.pipe(
    Effect.flatMap(decodeOutbox)
  );
  return { episodes, outbox };
});

/**
 * Delete episodes resolved before `before` that have no pending alert row,
 * with their alert rows. Returns the number of episodes deleted.
 */
export const pruneEpisodes = Effect.fn("WatchdogStore.pruneEpisodes")(
  function* pruneEpisodesEffect(before: number) {
    const sql = yield* SqlClient.SqlClient;
    const deleted = yield* sql<{ id: string }>`DELETE FROM watchdog_episodes
      WHERE resolved_at IS NOT NULL AND resolved_at < ${before}
        AND id NOT IN (
          SELECT incident_id FROM watchdog_outbox WHERE state = 'pending'
        )
      RETURNING id`;
    yield* sql`DELETE FROM watchdog_outbox
      WHERE incident_id NOT IN (SELECT id FROM watchdog_episodes)`;
    return deleted.length;
  }
);
