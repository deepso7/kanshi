import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { Monitor } from "../monitor/monitor.ts";
import type { Registry, RegistryEntry } from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";
import type { ObserveResult } from "../registry/watchdog-store.ts";
import {
  WatchdogAction,
  decide,
  episodeRetentionMs,
  needsStatus,
  watchdogConcurrency,
} from "./rules.ts";

export interface WatchdogDeps {
  readonly monitors: Effect.Success<typeof Monitor>;
  readonly registries: Effect.Success<typeof Registry>;
}

/** What the watchdog did with one Registry row. */
export interface RowReport {
  readonly action: WatchdogAction["_tag"] | "Error";
  readonly alarmAt?: number | null;
  readonly errors: readonly string[];
  readonly id: string;
  readonly lifecycle: RegistryEntry["lifecycle"];
  readonly outcome: string;
  readonly summaryUpdated?: boolean;
  readonly watch?: ObserveResult;
}

export interface WatchdogReport {
  readonly failed: number;
  readonly now: number;
  readonly pruned: number | null;
  readonly registryAlarmAt: number | null;
  readonly results: readonly RowReport[];
}

const describeCause = (cause: Cause.Cause<unknown>): string =>
  Cause.pretty(cause).split("\n", 1)[0]?.slice(0, 200) ?? "unknown error";

/**
 * The watchdog (cron every 5 minutes, or `POST /_dev/watchdog`): for every
 * Registry row, finish or clean up stuck creates, retry stuck deletes, and
 * for active monitors re-arm the alarm, refresh the cached summary and
 * watch for monitors that are not being checked. Rows are processed
 * independently with bounded concurrency; one failure never stops the
 * others. `now` is the run's clock (overridable in dev).
 */
export const runWatchdog = Effect.fn("Watchdog.run")(
  function* runWatchdogEffect(deps: WatchdogDeps, now: number) {
    const registry = () => deps.registries.getByName(registryName);
    const monitor = (id: string) => deps.monitors.getByName(id);

    /** Remove a row whose delete was started: tombstone, then drop it. */
    const finishDelete = (id: string) =>
      monitor(id)
        .destroy()
        .pipe(Effect.andThen(registry().remove(id)));

    const processRow = (row: RegistryEntry) =>
      Effect.gen(function* processRowEffect() {
        const base: Pick<RowReport, "errors" | "id" | "lifecycle"> = {
          errors: [],
          id: row.id,
          lifecycle: row.lifecycle,
        };
        const status = needsStatus(row, now)
          ? yield* monitor(row.id).status()
          : null;
        const action = decide(row, status, now);
        return yield* WatchdogAction.$match(action, {
          Abandon: ({ opId }) =>
            Effect.gen(function* abandonEffect() {
              const marked = yield* registry().markDeleting(row.id, opId);
              if (!marked) {
                return { ...base, action: action._tag, outcome: "row changed" };
              }
              yield* finishDelete(row.id);
              yield* Effect.logWarning(
                `watchdog abandoned stuck create ${row.id}`
              );
              return { ...base, action: action._tag, outcome: "removed" };
            }),
          Activate: ({ opId }) =>
            Effect.gen(function* activateEffect() {
              const activated = yield* registry().activate(row.id, opId);
              if (activated) {
                yield* Effect.logWarning(
                  `watchdog activated stuck create ${row.id}`
                );
              }
              return {
                ...base,
                action: action._tag,
                outcome: activated ? "activated" : "row changed",
              };
            }),
          Destroy: () =>
            Effect.gen(function* destroyEffect() {
              yield* finishDelete(row.id);
              yield* Effect.logWarning(
                `watchdog finished stuck delete ${row.id}`
              );
              return { ...base, action: action._tag, outcome: "removed" };
            }),
          Refresh: ({ observation, revision, summary }) =>
            Effect.gen(function* refreshEffect() {
              // Independent steps: a failure of one still runs the others.
              const errors: string[] = [];
              const step = <A, R>(
                label: string,
                effect: Effect.Effect<A, unknown, R>
              ) =>
                Effect.exit(effect).pipe(
                  Effect.map((exit) => {
                    if (Exit.isSuccess(exit)) {
                      return exit.value;
                    }
                    errors.push(`${label}: ${describeCause(exit.cause)}`);
                    return null;
                  })
                );
              const alarmAt = yield* step(
                "ensureAlarm",
                monitor(row.id).ensureAlarm()
              );
              const summaryUpdated = yield* step(
                "upsertSummary",
                registry().upsertSummary(row.id, summary, revision)
              );
              const watch = yield* step(
                "observe",
                registry().observe(row.id, observation, now)
              );
              const report: RowReport = {
                ...base,
                action: action._tag,
                alarmAt: alarmAt ?? null,
                errors,
                outcome: errors.length === 0 ? "refreshed" : "partly failed",
                summaryUpdated: summaryUpdated ?? false,
              };
              return watch === null ? report : { ...report, watch };
            }),
          Skip: ({ reason }) =>
            Effect.gen(function* skipEffect() {
              yield* Effect.logWarning(`watchdog skipped ${row.id}: ${reason}`);
              return { ...base, action: action._tag, outcome: reason };
            }),
          Wait: () =>
            Effect.succeed({
              ...base,
              action: action._tag,
              outcome: "waiting",
            }),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`watchdog failed for ${row.id}`, cause).pipe(
            Effect.as({
              action: "Error",
              errors: [describeCause(cause)],
              id: row.id,
              lifecycle: row.lifecycle,
              outcome: "failed",
            } satisfies RowReport)
          )
        )
      );

    const rows = yield* registry().list();
    const results: readonly RowReport[] = yield* Effect.forEach(
      rows,
      processRow,
      {
        concurrency: watchdogConcurrency,
      }
    );
    const pruned = yield* registry()
      .pruneWatchdog(now - episodeRetentionMs)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("pruning watchdog episodes failed", cause).pipe(
            Effect.as(null)
          )
        )
      );
    // The Registry's own alarm (watchdog alerts) is re-armed the same way.
    const registryAlarmAt = yield* registry()
      .ensureAlarm()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("re-arming the registry alarm failed", cause).pipe(
            Effect.as(null)
          )
        )
      );
    const failed = results.filter(
      (result) => result.action === "Error" || result.errors.length > 0
    ).length;
    const acted = results.filter(
      (result) => result.action !== "Refresh" && result.action !== "Wait"
    ).length;
    yield* Effect.logInfo(
      `watchdog checked ${results.length} monitors: ${acted} repaired or skipped, ${failed} failed`
    );
    return {
      failed,
      now,
      pruned,
      registryAlarmAt,
      results,
    } satisfies WatchdogReport;
  }
);
