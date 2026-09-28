import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { MonitorPatchInput } from "../domain/monitor-input.ts";
import { patchConfig } from "../domain/monitor-input.ts";
import type {
  Inflight,
  MonitorConfig,
  MonitorSnapshot,
  MonitorState,
} from "../domain/monitor.ts";
import { summaryOf } from "../domain/monitor.ts";
import { probe } from "../domain/probe.ts";
import { Registry, registryName } from "../registry/registry.ts";
import { openDurableSql } from "../storage/sqlite.ts";
import {
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
import { applyConfigChange } from "./reset.ts";
import type { CheckRow, IncidentRow } from "./storage.ts";
import {
  closeIncident,
  insertCheck,
  listIncidents,
  migrations,
  openIncident,
  readConfig,
  readState,
  readTombstone,
  recentChecks,
  wipe,
  writeConfig,
  writeState,
} from "./storage.ts";

export interface MonitorStatusView {
  readonly alarmAt: number | null;
  readonly snapshot: MonitorSnapshot | null;
  readonly tombstonedAt: number | null;
}

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
    checks: (
      limit: number
    ) => Effect.Effect<readonly CheckRow[], never, RuntimeContext>;
    incidents: (
      limit: number
    ) => Effect.Effect<readonly IncidentRow[], never, RuntimeContext>;
    /** Delete all data and leave a tombstone. Idempotent. */
    destroy: () => Effect.Effect<void, never, RuntimeContext>;
    /** Recompute and set the alarm from persisted state. */
    ensureAlarm: () => Effect.Effect<number | null, never, RuntimeContext>;
    alarm: (
      info?: Cloudflare.AlarmInvocationInfo
    ) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("Monitor", { errors: monitorErrors }) {}

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

    /** Best effort: the watchdog converges summaries that fail here. */
    const pushSummary = (config: MonitorConfig, current: MonitorState) =>
      registries
        .getByName(registryName)
        .upsertSummary(
          config.id,
          summaryOf(config, current),
          current.summaryRevision
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("summary push failed", cause).pipe(
              Effect.as(false)
            )
          ),
          Effect.asVoid
        );

    return Effect.gen(function* MonitorInstance() {
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

      const rearm = alarmLock
        .withPermits(1)(
          Effect.gen(function* rearmEffect() {
            const loaded = yield* withSql(load);
            const at =
              loaded.tombstonedAt !== null ||
              loaded.config === null ||
              loaded.state === null
                ? null
                : nextAlarmAt(loaded.config, loaded.state);
            yield* at === null
              ? state.storage.deleteAlarm()
              : state.storage.setAlarm(at);
            return at;
          })
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to set the alarm", cause).pipe(
              Effect.as(null)
            )
          )
        );

      /** Every mutation ends by re-arming and pushing the new summary. */
      const afterChange = (snapshot: MonitorSnapshot) =>
        rearm.pipe(
          Effect.andThen(pushSummary(snapshot.config, snapshot.state)),
          Effect.as(snapshot)
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
              return { config: loaded.config, state: loaded.state };
            }
            const initial = initialState(Date.now());
            yield* writeConfig(config);
            yield* writeState(initial);
            return { config, state: initial };
          })
        ).pipe(
          Effect.flatMap(afterChange),
          Effect.withSpan("Monitor.configure")
        );

      const update = (patch: MonitorPatchInput, options: UpdateOptions) =>
        transact(
          Effect.gen(function* updateTx() {
            const live = yield* loadLive;
            const now = Date.now();
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
            if (change.closeIncident !== null) {
              yield* closeIncident(
                change.closeIncident,
                change.closeIncident.resolution
              );
            }
            return { config: change.config, state: change.state };
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
            const next = { ...live.state, manualRequestedAt: Date.now() };
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
            const current = yield* readState;
            if (current?.openIncidentId) {
              yield* closeIncident(
                { id: current.openIncidentId, resolvedAt: Date.now() },
                "deleted"
              );
            }
            yield* wipe(Date.now());
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
          const expired = expireInflight(live.config, live.state, Date.now());
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
          const now = Date.now();
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
            const completion = completeCheck(
              live.config,
              live.state,
              inflight,
              outcome,
              Date.now()
            );
            if (completion._tag === "Stale") {
              yield* Effect.logInfo(
                `stale result discarded for check ${inflight.checkId}`
              );
              return null;
            }
            yield* writeState(completion.state);
            yield* insertCheck(completion.check);
            if (completion.openIncident !== null) {
              yield* openIncident(completion.openIncident);
            }
            if (completion.closeIncident !== null) {
              yield* closeIncident(completion.closeIncident, "recovered");
            }
            if (completion.transition !== "none") {
              yield* Effect.logInfo(
                `monitor ${live.config.name} is ${completion.state.status}`
              );
            }
            return { config: live.config, state: completion.state };
          })
        ).pipe(Effect.orElseSucceed(() => null));

      const checkStep = Effect.gen(function* checkStepEffect() {
        const started = yield* beginCheck;
        if (started === null) {
          return;
        }
        // The in-flight record is committed; arm its deadline before probing.
        yield* rearm;
        const outcome = yield* probe({
          bodyContains: started.config.bodyContains,
          expectedStatus: started.config.expectedStatus,
          method: started.config.method,
          timeoutMs: started.config.timeoutMs,
          url: started.config.url,
        });
        const committed = yield* commitCheck(started.inflight, outcome);
        if (committed !== null) {
          yield* pushSummary(committed.config, committed.state);
        }
      });

      const alarm = (_info?: Cloudflare.AlarmInvocationInfo) =>
        Effect.gen(function* alarmEffect() {
          yield* logged("expire")(expireStep);
          yield* logged("check")(checkStep);
          yield* rearm;
        }).pipe(Effect.withSpan("Monitor.alarm"));

      return {
        alarm,
        checks: (limit: number) =>
          withSql(recentChecks(limit)).pipe(Effect.orDie),
        configure,
        destroy,
        ensureAlarm: () => rearm,
        incidents: (limit: number) =>
          withSql(listIncidents(limit)).pipe(Effect.orDie),
        runNow,
        snapshot: () =>
          withSql(loadLive).pipe(Effect.catchTag("SqlError", Effect.die)),
        status,
        update,
      };
    });
  })
);
