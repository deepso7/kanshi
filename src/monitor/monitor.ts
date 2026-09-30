import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { deliver, DeliveryResult } from "../alerts/delivery.ts";
import {
  alertRequest,
  idempotencyKey,
  incidentMessage,
} from "../alerts/message.ts";
import type { Notification, OutboxEntry } from "../domain/alert.ts";
import type {
  IncidentWithAlerts,
  RecentActivity,
  UptimeDay,
  UptimeReport,
} from "../domain/history.ts";
import type { MonitorPatchInput } from "../domain/monitor-input.ts";
import { patchConfig } from "../domain/monitor-input.ts";
import type {
  Inflight,
  MonitorConfig,
  MonitorSnapshot,
  MonitorState,
  MonitorSummary,
} from "../domain/monitor.ts";
import {
  owePush,
  settlePush,
  shouldPushSummary,
  summaryOf,
} from "../domain/monitor.ts";
import { probe } from "../domain/probe.ts";
import { Registry, registryName } from "../registry/registry.ts";
import { openDurableSql } from "../storage/sqlite.ts";
import { alarmRestored, isStale } from "../watchdog/rules.ts";
import {
  Completion,
  completeCheck,
  dueCheck,
  expireInflight,
  initialState,
  nextAlarmAt,
  startCheck,
} from "./cycle.ts";
import {
  InvalidMonitorInput,
  MonitorDisabled,
  MonitorIdMismatch,
  MonitorNotConfigured,
  MonitorTombstoned,
  monitorErrors,
} from "./errors.ts";
import {
  checksPruneBefore,
  dayMs,
  dayStart,
  daysToRollUp,
  incidentsPruneBefore,
  maxRollupDaysPerRun,
  nextMaintenanceTime,
  periodChange,
  recentActivity,
  reportDays,
  rollupDay,
  uptimeDay,
  uptimeReport,
} from "./history.ts";
import {
  afterAttempt,
  deferred,
  dueNotifications,
  deliverDue,
  dueOutbox,
  notificationFailed,
  notificationsDueAt,
  OutboxDecision,
  outboxDecision,
  outboxDueAt,
  skipped,
} from "./outbox.ts";
import { applyConfigChange } from "./reset.ts";
import type { CheckRow, PruneCounts } from "./storage.ts";
import {
  closeIncident,
  incidentAlerts,
  insertCheck,
  insertNotification,
  listIncidents,
  migrations,
  openIncident,
  prune,
  readAlertWork,
  readConfig,
  incidentExcerpt,
  readIncident,
  readOutboxPair,
  readPeriods,
  readRecent,
  readRollups,
  readSamples,
  readState,
  readTombstone,
  recentAlerts,
  recentChecks,
  recordPeriodChange,
  resolveDown,
  resolveUp,
  wipe,
  writeConfig,
  writeNotification,
  writeOutbox,
  writeRollup,
  writeState,
} from "./storage.ts";

export interface MonitorStatusView {
  readonly alarmAt: number | null;
  readonly snapshot: MonitorSnapshot | null;
  readonly tombstonedAt: number | null;
}

/** What the watchdog's `reconcile()` returns. */
export interface MonitorReconcileView extends MonitorStatusView {
  /** The alarm was lost (or late) and this call restored it. */
  readonly alarmRestored: boolean;
}

/** Recent alert rows, for the dev inspector and tests. */
export interface MonitorAlertsView {
  readonly notifications: readonly Notification[];
  readonly outbox: readonly OutboxEntry[];
  readonly recipients: readonly {
    readonly channelId: string;
    readonly incidentId: string;
  }[];
}

/** What a maintenance run did (for the dev hook and logs). */
export interface MaintenanceResult {
  readonly nextMaintenanceAt: number | null;
  readonly pruned: PruneCounts;
  readonly rolledUp: readonly string[];
  readonly rolledUpThrough: string | null;
}

/**
 * One monitor as the dashboard shows it, read live in a single call: its
 * recent activity plus what the Registry does not keep fresh (the last
 * check time) or may lag on (status, after a lost push).
 */
export interface MonitorOverview {
  readonly lastCheckedAt: number | null;
  readonly recent: RecentActivity;
  /** Enabled, and not checked for longer than the watchdog allows. */
  readonly stale: boolean;
  /** Null when the monitor is not configured (or deleted). */
  readonly summary: MonitorSummary | null;
}

export interface ChecksQuery {
  readonly limit: number;
  readonly since?: number | undefined;
}

/** How long a failed maintenance run waits before the next try. */
const maintenanceRetryMs = 60 * 60 * 1000;

export interface UpdateOptions {
  readonly devMode: boolean;
}

/**
 * One Durable Object per monitor (name = monitor id). It owns the monitor's
 * configuration, state, checks and incidents, and drives itself with its
 * alarm, which is always recomputed from persisted state.
 */
export class Monitor extends Cloudflare.DurableObject<
  Monitor,
  {
    /** Store the initial configuration. Idempotent; fails once deleted. */
    configure: (
      config: MonitorConfig
    ) => Effect.Effect<
      MonitorSnapshot,
      MonitorIdMismatch | MonitorTombstoned,
      RuntimeContext
    >;
    update: (
      patch: MonitorPatchInput,
      options: UpdateOptions
    ) => Effect.Effect<
      MonitorSnapshot,
      InvalidMonitorInput | MonitorNotConfigured | MonitorTombstoned,
      RuntimeContext
    >;
    /** Request a check as soon as none is in flight (coalesced). */
    runNow: () => Effect.Effect<
      MonitorSnapshot,
      MonitorDisabled | MonitorNotConfigured | MonitorTombstoned,
      RuntimeContext
    >;
    snapshot: () => Effect.Effect<
      MonitorSnapshot,
      MonitorNotConfigured | MonitorTombstoned,
      RuntimeContext
    >;
    status: () => Effect.Effect<MonitorStatusView, never, RuntimeContext>;
    /** Checks at or after `since`, newest first. */
    checks: (
      query: ChecksQuery
    ) => Effect.Effect<readonly CheckRow[], never, RuntimeContext>;
    /** Incidents with their alert rows, newest first. */
    incidents: (
      limit: number
    ) => Effect.Effect<readonly IncidentWithAlerts[], never, RuntimeContext>;
    /** Per-day uptime for the last `days` days, today computed live. */
    uptime: (
      days: number
    ) => Effect.Effect<
      UptimeReport,
      MonitorNotConfigured | MonitorTombstoned,
      RuntimeContext
    >;
    /**
     * Counted samples in the last `windowMs` and latency in `buckets`
     * equal buckets (the dashboard's 24h uptime and sparkline).
     */
    recent: (
      windowMs: number,
      buckets: number
    ) => Effect.Effect<RecentActivity, never, RuntimeContext>;
    /**
     * `recent` plus the live last check time, summary and staleness: the
     * dashboard's one call per monitor.
     */
    overview: (
      windowMs: number,
      buckets: number
    ) => Effect.Effect<MonitorOverview, never, RuntimeContext>;
    /** Run maintenance as of `now` whether due or not (dev hook). */
    maintain: (
      now: number
    ) => Effect.Effect<
      MaintenanceResult,
      MonitorNotConfigured | MonitorTombstoned,
      RuntimeContext
    >;
    alerts: (
      limit: number
    ) => Effect.Effect<MonitorAlertsView, never, RuntimeContext>;
    /** Delete all data and leave a tombstone. Idempotent. */
    destroy: () => Effect.Effect<void, never, RuntimeContext>;
    /**
     * The watchdog's one call per run: recompute and set the alarm from
     * persisted state (restoring a lost one), then report the status (the
     * alarm, snapshot and tombstone) it decides on, and whether the alarm
     * had to be restored.
     */
    reconcile: () => Effect.Effect<MonitorReconcileView, never, RuntimeContext>;
    /**
     * Dev stage: delete the alarm without touching state, as if it had been
     * lost. Only the watchdog's `reconcile()` brings it back.
     */
    devClearAlarm: () => Effect.Effect<void, never, RuntimeContext>;
    alarm: (
      info?: Cloudflare.AlarmInvocationInfo
    ) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("Monitor", { errors: monitorErrors }) {}

/** A committed change: the snapshot before it (null if new) and after. */
interface Change {
  readonly after: MonitorSnapshot;
  readonly before: MonitorSnapshot | null;
}

interface Loaded {
  readonly config: MonitorConfig | null;
  readonly state: MonitorState | null;
  readonly tombstonedAt: number | null;
}

const load = Effect.gen(function* loadEffect() {
  const tombstonedAt = yield* readTombstone;
  const config = yield* readConfig;
  const state = yield* readState;
  return { config, state, tombstonedAt } satisfies Loaded;
});

/** The configured monitor, or the reason there is none. */
const loadLive = Effect.gen(function* loadLiveEffect() {
  const loaded = yield* load;
  if (loaded.tombstonedAt !== null) {
    return yield* new MonitorTombstoned({
      monitorId: loaded.config?.id ?? "",
    });
  }
  if (loaded.config === null || loaded.state === null) {
    return yield* new MonitorNotConfigured();
  }
  return { config: loaded.config, state: loaded.state };
});

const describeCause = (cause: Cause.Cause<unknown>): string =>
  Cause.pretty(cause).split("\n", 1)[0]?.slice(0, 200) ?? "unknown error";

/** Alarm steps catch their own failures so later steps still run. */
const logged =
  (step: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`alarm step ${step} failed`, cause).pipe(
          Effect.as(null)
        )
      )
    );

export const MonitorLive = Monitor.make(
  Effect.gen(function* MonitorInit() {
    const state = yield* Cloudflare.DurableObjectState;
    const registries = yield* Registry;
    const http = yield* HttpClient.HttpClient;

    const registry = () => registries.getByName(registryName);
    /** Probes and alert deliveries use the Worker's `HttpClient`. */
    const withHttp = Effect.provideService(HttpClient.HttpClient, http);

    return Effect.gen(function* MonitorInstance() {
      const sql = yield* openDurableSql(state, migrations);
      // Serialises alarm updates so the last one written is computed from
      // the latest committed state.
      const alarmLock = yield* Semaphore.make(1);
      // The newest summary revision whose push failed, or null; the next
      // check retries it. Kept in memory only: after an eviction the hourly
      // watchdog converges it.
      let owedRevision: number | null = null;
      // Whether the alarm handler is running (its alarm is not lost).
      let alarmRunning = false;

      /**
       * Push the summary only when a Registry-visible field changed
       * (`shouldPushSummary`) or an earlier push failed, so a check that
       * changes nothing makes no Registry request. Best effort: the
       * watchdog converges a push that keeps failing (same revision rule).
       */
      const pushSummary = (change: Change) => {
        const revision = change.after.state.summaryRevision;
        return owedRevision !== null ||
          shouldPushSummary(change.before, change.after)
          ? registry()
              .upsertSummary(
                change.after.config.id,
                summaryOf(change.after.config, change.after.state),
                revision
              )
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    owedRevision = settlePush(owedRevision, revision);
                  })
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("summary push failed", cause).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        owedRevision = owePush(owedRevision, revision);
                      })
                    )
                  )
                ),
                Effect.asVoid
              )
          : Effect.void;
      };

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

      /**
       * Set the alarm from persisted state; returns it, and whether this
       * restored a lost one (`alarmRestored`).
       */
      const rearmReport = alarmLock
        .withPermits(1)(
          Effect.gen(function* rearmEffect() {
            const previous = yield* state.storage.getAlarm();
            const loaded = yield* withSql(load);
            const work = yield* withSql(readAlertWork);
            const at =
              loaded.tombstonedAt !== null ||
              loaded.config === null ||
              loaded.state === null
                ? null
                : nextAlarmAt(loaded.config, loaded.state, [
                    notificationsDueAt(work.notifications),
                    outboxDueAt(work.outbox),
                  ]);
            yield* at === null
              ? state.storage.deleteAlarm()
              : state.storage.setAlarm(at);
            return {
              at,
              restored: alarmRestored(previous, at, alarmRunning),
            };
          })
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to set the alarm", cause).pipe(
              Effect.as({ at: null, restored: false })
            )
          )
        );

      const rearm = rearmReport.pipe(Effect.map(({ at }) => at));

      /**
       * Every mutation ends by re-arming and, if its summary changed,
       * pushing it.
       */
      const afterChange = (change: Change) =>
        rearm.pipe(
          Effect.andThen(pushSummary(change)),
          Effect.as(change.after)
        );

      const configure = (config: MonitorConfig) =>
        transact(
          Effect.gen(function* configureTx() {
            const loaded = yield* load;
            if (loaded.tombstonedAt !== null) {
              return yield* new MonitorTombstoned({ monitorId: config.id });
            }
            if (loaded.config !== null && loaded.state !== null) {
              if (loaded.config.id !== config.id) {
                return yield* new MonitorIdMismatch({
                  expected: loaded.config.id,
                  received: config.id,
                });
              }
              const current = { config: loaded.config, state: loaded.state };
              return { after: current, before: current } satisfies Change;
            }
            const now = yield* Clock.currentTimeMillis;
            const initial = initialState(now);
            yield* writeConfig(config);
            yield* writeState(initial);
            yield* recordPeriodChange(periodChange(null, config), now);
            return {
              after: { config, state: initial },
              before: null,
            } satisfies Change;
          })
        ).pipe(
          Effect.flatMap(afterChange),
          Effect.withSpan("Monitor.configure")
        );

      const update = (patch: MonitorPatchInput, options: UpdateOptions) =>
        transact(
          Effect.gen(function* updateTx() {
            const live = yield* loadLive;
            const now = yield* Clock.currentTimeMillis;
            const patched = patchConfig(live.config, patch, {
              devMode: options.devMode,
              now,
            });
            if (Result.isFailure(patched)) {
              return yield* new InvalidMonitorInput({
                message: patched.failure,
              });
            }
            const change = applyConfigChange(
              live.config,
              patched.success,
              live.state,
              now
            );
            yield* writeConfig(change.config);
            yield* writeState(change.state);
            yield* recordPeriodChange(
              periodChange(live.config, change.config),
              now
            );
            if (change.closeIncident !== null) {
              yield* closeIncident(
                change.closeIncident,
                change.closeIncident.resolution
              );
            }
            return {
              after: { config: change.config, state: change.state },
              before: live,
            } satisfies Change;
          })
        ).pipe(Effect.flatMap(afterChange), Effect.withSpan("Monitor.update"));

      const runNow = () =>
        transact(
          Effect.gen(function* runNowTx() {
            const live = yield* loadLive;
            if (!live.config.enabled) {
              return yield* new MonitorDisabled({ monitorId: live.config.id });
            }
            // Any check that starts after this request answers it, so
            // repeated requests collapse into one.
            const now = yield* Clock.currentTimeMillis;
            const next = { ...live.state, manualRequestedAt: now };
            yield* writeState(next);
            return { config: live.config, state: next };
          })
        ).pipe(
          Effect.tap(() => rearm),
          Effect.withSpan("Monitor.runNow")
        );

      const destroy = () =>
        transact(
          Effect.gen(function* destroyTx() {
            if ((yield* readTombstone) !== null) {
              return;
            }
            // The incident is closed for the record, then every row goes.
            const now = yield* Clock.currentTimeMillis;
            const current = yield* readState;
            if (current?.openIncidentId) {
              yield* closeIncident(
                { id: current.openIncidentId, resolvedAt: now },
                "deleted"
              );
            }
            yield* wipe(now);
          })
        ).pipe(
          Effect.andThen(rearm),
          Effect.asVoid,
          Effect.withSpan("Monitor.destroy")
        );

      const status = () =>
        Effect.gen(function* statusEffect() {
          const loaded = yield* withSql(load).pipe(Effect.orDie);
          const alarmAt = yield* state.storage.getAlarm();
          return {
            alarmAt,
            snapshot:
              loaded.config !== null && loaded.state !== null
                ? { config: loaded.config, state: loaded.state }
                : null,
            tombstonedAt: loaded.tombstonedAt,
          } satisfies MonitorStatusView;
        });

      const expireStep = transact(
        Effect.gen(function* expireTx() {
          const live = yield* loadLive;
          const now = yield* Clock.currentTimeMillis;
          const expired = expireInflight(live.config, live.state, now);
          if (expired !== null) {
            yield* Effect.logWarning(
              `in-flight check ${live.state.inflight?.checkId} expired`
            );
            yield* writeState(expired);
          }
        })
      ).pipe(Effect.ignore);

      const beginCheck = transact(
        Effect.gen(function* beginCheckTx() {
          const live = yield* loadLive;
          const now = yield* Clock.currentTimeMillis;
          const kind = dueCheck(live.config, live.state, now);
          if (kind === null) {
            return null;
          }
          const started = startCheck(
            live.config,
            live.state,
            kind,
            crypto.randomUUID(),
            now
          );
          yield* writeState(started.state);
          return { config: live.config, inflight: started.inflight };
        })
      ).pipe(Effect.orElseSucceed(() => null));

      const commitCheck = (
        inflight: Inflight,
        outcome: Parameters<typeof completeCheck>[3]
      ) =>
        transact(
          Effect.gen(function* commitCheckTx() {
            const live = yield* loadLive;
            const now = yield* Clock.currentTimeMillis;
            const completion = completeCheck(
              live.config,
              live.state,
              inflight,
              outcome,
              now
            );
            if (Completion.$is("Stale")(completion)) {
              yield* Effect.logInfo(
                `stale result discarded for check ${inflight.checkId}`
              );
              return null;
            }
            yield* writeState(completion.state);
            yield* insertCheck(completion.check);
            // The intent to alert commits with the transition; the alarm
            // resolves and sends it (no cross-DO call in here).
            if (completion.openIncident !== null) {
              yield* openIncident(completion.openIncident);
              yield* insertNotification(
                completion.openIncident.id,
                "down",
                completion.check.at
              );
            }
            if (completion.closeIncident !== null) {
              yield* closeIncident(completion.closeIncident, "recovered");
              yield* insertNotification(
                completion.closeIncident.id,
                "up",
                completion.check.at
              );
            }
            if (completion.transition !== "none") {
              yield* Effect.logInfo(
                `monitor ${live.config.name} is ${completion.state.status}`
              );
            }
            return {
              after: { config: live.config, state: completion.state },
              before: live,
            } satisfies Change;
          })
        ).pipe(Effect.orElseSucceed(() => null));

      const checkStep = Effect.gen(function* checkStepEffect() {
        const started = yield* beginCheck;
        if (started === null) {
          return;
        }
        // The in-flight record is committed; arm its deadline before probing.
        yield* rearm;
        const outcome = yield* withHttp(
          probe({
            bodyContains: started.config.bodyContains,
            expectedStatus: started.config.expectedStatus,
            method: started.config.method,
            timeoutMs: started.config.timeoutMs,
            url: started.config.url,
          })
        );
        const committed = yield* commitCheck(started.inflight, outcome);
        if (committed !== null) {
          yield* pushSummary(committed);
        }
      });

      /**
       * `down`: fetch the monitor's channels from the Registry (outside any
       * transaction), then fix the recipients, queue one `down` row each and
       * mark it resolved in one transaction. `up`: once its `down` is
       * resolved, queue one `up` row per recipient. A Registry failure
       * retries the notification with backoff.
       */
      const resolveNotification = (
        notification: Notification,
        config: MonitorConfig
      ) =>
        Effect.gen(function* resolveNotificationEffect() {
          const { notifications } = yield* withSql(readAlertWork);
          const current = notifications.find(
            (other) =>
              other.incidentId === notification.incidentId &&
              other.event === notification.event
          );
          if (current === undefined || current.resolved) {
            return;
          }
          if (current.event === "up") {
            const down = notifications.find(
              (other) =>
                other.incidentId === current.incidentId &&
                other.event === "down"
            );
            if (down !== undefined && !down.resolved) {
              return;
            }
            const resolvedAt = yield* Clock.currentTimeMillis;
            yield* transact(resolveUp(current.incidentId, resolvedAt));
            return;
          }
          const recipients = yield* registry()
            .recipients(config.channels)
            .pipe(Effect.exit);
          if (Exit.isFailure(recipients)) {
            yield* Effect.logWarning(
              `resolving recipients for incident ${current.incidentId} failed`,
              recipients.cause
            );
            const failedAt = yield* Clock.currentTimeMillis;
            yield* transact(
              writeNotification(
                notificationFailed(
                  current,
                  `registry: ${describeCause(recipients.cause)}`,
                  failedAt
                )
              )
            );
            return;
          }
          const resolvedAt = yield* Clock.currentTimeMillis;
          yield* transact(
            resolveDown(current.incidentId, recipients.value, resolvedAt)
          );
        });

      const notifyStep = Effect.gen(function* notifyStepEffect() {
        const live = yield* withSql(loadLive);
        const { notifications } = yield* withSql(readAlertWork);
        const now = yield* Clock.currentTimeMillis;
        for (const notification of dueNotifications(notifications, now)) {
          yield* logged(`notify ${notification.incidentId}`)(
            resolveNotification(notification, live.config)
          );
        }
      });

      /** Decide, and possibly send, one outbox row. */
      const sendOne = (due: OutboxEntry, config: MonitorConfig) =>
        Effect.gen(function* sendOneEffect() {
          const pair = yield* withSql(
            readOutboxPair(due.incidentId, due.event, due.channelId)
          );
          const { entry } = pair;
          if (entry === null) {
            return;
          }
          const incident = yield* withSql(readIncident(entry.incidentId));
          const decision = outboxDecision(entry, pair.down, incident);
          if (
            OutboxDecision.$is("Done")(decision) ||
            OutboxDecision.$is("Wait")(decision)
          ) {
            return;
          }
          if (OutboxDecision.$is("Skip")(decision) || incident === null) {
            const reason = OutboxDecision.$is("Skip")(decision)
              ? decision.reason
              : "incident no longer exists";
            const now = yield* Clock.currentTimeMillis;
            yield* transact(writeOutbox(skipped(entry, reason, now)));
            return;
          }
          const target = yield* registry()
            .channelTarget(entry.channelId)
            .pipe(Effect.exit);
          if (Exit.isFailure(target)) {
            yield* Effect.logWarning(
              `resolving channel ${entry.channelId} failed`,
              target.cause
            );
            const now = yield* Clock.currentTimeMillis;
            yield* transact(
              writeOutbox(
                deferred(entry, `registry: ${describeCause(target.cause)}`, now)
              )
            );
            return;
          }
          if (target.value === null) {
            const gone = DeliveryResult.Failed({
              error: "channel deleted",
              permanent: true,
              status: null,
            });
            const now = yield* Clock.currentTimeMillis;
            yield* transact(writeOutbox(afterAttempt(entry, gone, false, now)));
            return;
          }
          const sentAt = yield* Clock.currentTimeMillis;
          const result = yield* withHttp(
            deliver(
              alertRequest(
                target.value.kind,
                target.value.url,
                incidentMessage(decision.message, {
                  idempotencyKey: idempotencyKey(
                    entry.incidentId,
                    entry.event,
                    entry.channelId
                  ),
                  incident: {
                    cause: incident.cause,
                    id: incident.id,
                    lastHttpStatus: incident.lastHttpStatus,
                    latencyMs: incident.latencyMs,
                    resolvedAt: incident.resolvedAt,
                    responseExcerpt: incidentExcerpt(incident),
                    startedAt: incident.startedAt,
                  },
                  monitor: {
                    id: config.id,
                    name: config.name,
                    url: config.url,
                  },
                  sentAt,
                })
              )
            )
          );
          if (DeliveryResult.$is("Failed")(result)) {
            yield* Effect.logWarning(
              `alert ${entry.incidentId}:${entry.event} to ${entry.channelId} failed: ${result.error}`
            );
          }
          const attemptedAt = yield* Clock.currentTimeMillis;
          yield* transact(
            writeOutbox(
              afterAttempt(
                entry,
                result,
                decision.message === "DownRecovered",
                attemptedAt
              )
            )
          );
        });

      /**
       * Bounded by `deliveryLimits` (concurrency, rows and time per run);
       * rows left over stay due and the alarm re-arms for them at once.
       */
      const deliverStep = Effect.gen(function* deliverStepEffect() {
        const live = yield* withSql(loadLive);
        const { outbox } = yield* withSql(readAlertWork);
        const now = yield* Clock.currentTimeMillis;
        yield* deliverDue(dueOutbox(outbox, now), (entry) =>
          logged(`deliver ${entry.incidentId}:${entry.event}`)(
            sendOne(entry, live.config)
          ).pipe(Effect.asVoid)
        );
      });

      /**
       * Roll every closed day after the watermark up and advance it in the
       * same transaction, then prune by retention. Runs when
       * `nextMaintenanceAt` is due, or always when `force`d.
       */
      const maintain = (now: number, force: boolean) =>
        transact(
          Effect.gen(function* maintainTx() {
            const live = yield* loadLive;
            if (!force && (live.state.nextMaintenanceAt ?? 0) > now) {
              return null;
            }
            const days = daysToRollUp(
              live.state.rolledUpThrough,
              live.config.createdAt,
              now
            );
            for (const day of days) {
              const from = dayStart(day);
              const samples = yield* readSamples(from, from + dayMs);
              const periods = yield* readPeriods(from, from + dayMs);
              yield* writeRollup(rollupDay(day, samples, periods));
            }
            const rolledUpThrough = days.at(-1) ?? live.state.rolledUpThrough;
            const more =
              days.length === maxRollupDaysPerRun &&
              daysToRollUp(rolledUpThrough, live.config.createdAt, now, 1)
                .length > 0;
            const nextMaintenanceAt = more ? now : nextMaintenanceTime(now);
            yield* writeState({
              ...live.state,
              nextMaintenanceAt,
              rolledUpThrough,
            });
            const pruned = yield* prune(
              checksPruneBefore(rolledUpThrough, now),
              rolledUpThrough === null
                ? null
                : dayStart(rolledUpThrough) + dayMs,
              incidentsPruneBefore(now)
            );
            return {
              nextMaintenanceAt,
              pruned,
              rolledUp: days,
              rolledUpThrough,
            } satisfies MaintenanceResult;
          })
        );

      /** A failed run retries in an hour rather than spinning the alarm. */
      const postponeMaintenance = transact(
        Effect.gen(function* postponeMaintenanceTx() {
          const live = yield* loadLive;
          const now = yield* Clock.currentTimeMillis;
          yield* writeState({
            ...live.state,
            nextMaintenanceAt: now + maintenanceRetryMs,
          });
        })
      ).pipe(Effect.ignore);

      const maintainStep = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => maintain(now, false)),
        Effect.tap((result) =>
          result === null
            ? Effect.void
            : Effect.logInfo(
                `maintenance rolled up ${result.rolledUp.length} days through ${result.rolledUpThrough}, pruned ${result.pruned.checks} checks, ${result.pruned.incidents} incidents`
              )
        ),
        Effect.catchTags({
          MonitorNotConfigured: () => Effect.void,
          MonitorTombstoned: () => Effect.void,
        }),
        Effect.tapCause(() => postponeMaintenance)
      );

      const uptime = (days: number) =>
        withSql(
          Effect.gen(function* uptimeEffect() {
            const live = yield* loadLive;
            const now = yield* Clock.currentTimeMillis;
            const covered = reportDays(days, live.config.createdAt, now);
            const [first] = covered;
            const last = covered.at(-1);
            if (first === undefined || last === undefined) {
              return uptimeReport([]);
            }
            const watermark = live.state.rolledUpThrough;
            const stored = new Map(
              (yield* readRollups(first, last)).map((row) => [row.day, row])
            );
            const result: UptimeDay[] = [];
            for (const day of covered) {
              if (watermark !== null && day <= watermark) {
                const row = stored.get(day);
                if (row !== undefined) {
                  result.push(uptimeDay(row, false));
                }
                continue;
              }
              // Today, or a closed day maintenance has not reached yet.
              const from = dayStart(day);
              const samples = yield* readSamples(from, from + dayMs);
              const periods = yield* readPeriods(from, from + dayMs);
              result.push(
                uptimeDay(rollupDay(day, samples, periods, now), true)
              );
            }
            return uptimeReport(result);
          })
        ).pipe(Effect.catchTag("SqlError", Effect.die));

      const incidents = (limit: number) =>
        withSql(
          Effect.gen(function* incidentsEffect() {
            const rows = yield* listIncidents(limit);
            const alerts = yield* incidentAlerts(rows.map((row) => row.id));
            return rows.map((row): IncidentWithAlerts => ({
              ...row,
              alerts: alerts.filter((alert) => alert.incidentId === row.id),
            }));
          })
        ).pipe(Effect.orDie);

      const recent = (windowMs: number, buckets: number) => {
        const count = Math.max(1, Math.floor(buckets));
        const bucketMs = Math.max(1, Math.ceil(windowMs / count));
        return Effect.gen(function* recentEffect() {
          const since = (yield* Clock.currentTimeMillis) - bucketMs * count;
          const rows = yield* withSql(readRecent(since, bucketMs));
          return recentActivity(since, bucketMs, count, rows);
        }).pipe(Effect.orDie);
      };

      const alarm = (_info?: Cloudflare.AlarmInvocationInfo) =>
        Effect.gen(function* alarmEffect() {
          alarmRunning = true;
          yield* logged("expire")(expireStep);
          // Checks run before delivery, which is bounded in time, so slow
          // alert channels cannot delay them.
          yield* logged("check")(checkStep);
          yield* logged("notify")(notifyStep);
          yield* logged("deliver")(deliverStep);
          yield* logged("maintain")(maintainStep);
          yield* rearm;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              alarmRunning = false;
            })
          ),
          Effect.withSpan("Monitor.alarm")
        );

      return {
        alarm,
        alerts: (limit: number) =>
          withSql(recentAlerts(limit)).pipe(Effect.orDie),
        checks: (query: ChecksQuery) =>
          withSql(recentChecks(query)).pipe(Effect.orDie),
        configure,
        destroy,
        devClearAlarm: () =>
          alarmLock.withPermits(1)(state.storage.deleteAlarm()),
        incidents,
        maintain: (now: number) =>
          maintain(now, true).pipe(
            Effect.flatMap((result) =>
              result === null
                ? Effect.die("maintenance skipped")
                : Effect.succeed(result)
            ),
            Effect.tap(() => rearm)
          ),
        overview: (windowMs: number, buckets: number) =>
          Effect.gen(function* overviewEffect() {
            const activity = yield* recent(windowMs, buckets);
            const loaded = yield* withSql(load).pipe(Effect.orDie);
            const now = yield* Clock.currentTimeMillis;
            const live =
              loaded.tombstonedAt === null &&
              loaded.config !== null &&
              loaded.state !== null
                ? { config: loaded.config, state: loaded.state }
                : null;
            return {
              lastCheckedAt: live?.state.lastCheckedAt ?? null,
              recent: activity,
              stale: live !== null && isStale(live, now),
              summary:
                live === null ? null : summaryOf(live.config, live.state),
            } satisfies MonitorOverview;
          }),
        recent,
        reconcile: () =>
          rearmReport.pipe(
            Effect.flatMap(({ restored }) =>
              status().pipe(
                Effect.map((view): MonitorReconcileView => ({
                  ...view,
                  alarmRestored: restored,
                }))
              )
            ),
            Effect.withSpan("Monitor.reconcile")
          ),
        runNow,
        snapshot: () =>
          withSql(loadLive).pipe(Effect.catchTag("SqlError", Effect.die)),
        status,
        update,
        uptime,
      };
    });
  })
);
