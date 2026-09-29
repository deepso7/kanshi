import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { Monitor } from "../monitor/monitor.ts";
import type {
  ConfirmReport,
  ReconcileReport,
  Registry,
  RegistryEntry,
} from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";
import type { ObserveResult } from "../registry/watchdog-store.ts";
import type { ReconcileItem } from "./rules.ts";
import {
  WatchdogAction,
  confirmSuspect,
  decide,
  needsReconcile,
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
  /**
   * The batch found the monitor stale (`suspect`); its episode opened only
   * if the fresh read confirmed it (`watch` is then the confirming write's).
   */
  readonly suspect?: boolean;
  readonly watch?: ObserveResult;
}

export interface WatchdogReport {
  readonly failed: number;
  readonly now: number;
  readonly pruned: number | null;
  readonly registryAlarmAt: number | null;
  readonly results: readonly RowReport[];
}

/**
 * A row after its own step: either done, or an active monitor whose
 * refresh goes into the batched Registry call.
 */
type RowStep =
  | { readonly done: RowReport }
  | {
      readonly item: ReconcileItem;
      readonly report: RowReport;
    };

const describeCause = (cause: Cause.Cause<unknown>): string =>
  Cause.pretty(cause).split("\n", 1)[0]?.slice(0, 200) ?? "unknown error";

/**
 * The watchdog (hourly cron, or `POST /_dev/watchdog`). Per run:
 *
 * 1. `registry.list()`.
 * 2. For every row, with bounded concurrency (one failure never stops the
 *    others): a stuck delete is finished (`destroy()`, `remove()`); a
 *    `creating` row older than five minutes is activated or abandoned
 *    after one `reconcile()`; an active monitor gets exactly one call,
 *    `reconcile()`, which re-arms its alarm and returns its status.
 * 3. One `registry.reconcile(items, now)` for every active monitor:
 *    summary refreshes (revision-checked, so lost pushes converge) and
 *    "not being checked" episodes (resolve, close), then pruning and the
 *    Registry's alarm. A monitor it would open an episode for comes back
 *    as a suspect instead.
 * 4. Only with suspects: each is read again (`status()`, after the batch,
 *    so it sees any check or disable the monitor committed since its first
 *    read, pushed or not), and one `registry.confirmStale(items, now)`
 *    opens episodes for those still stale at the same revision
 *    (`confirmSuspect`); none left, no call.
 *
 * So a run makes `2 + active monitors` requests when nothing is stuck and
 * nothing opens (the steady state), and `3 + active monitors + suspects`
 * when some monitor is found stale (`2 + active monitors + suspects` when
 * no re-read confirms it). `now` is the run's clock (overridable in dev).
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
        const status = needsReconcile(row, now)
          ? yield* monitor(row.id).reconcile()
          : null;
        const action = decide(row, status, now);
        const done = (report: RowReport): RowStep => ({ done: report });
        return yield* WatchdogAction.$match(action, {
          Abandon: ({ opId }) =>
            Effect.gen(function* abandonEffect() {
              const marked = yield* registry().markDeleting(row.id, opId);
              if (!marked) {
                return done({
                  ...base,
                  action: action._tag,
                  outcome: "row changed",
                });
              }
              yield* finishDelete(row.id);
              yield* Effect.logWarning(
                `watchdog abandoned stuck create ${row.id}`
              );
              return done({ ...base, action: action._tag, outcome: "removed" });
            }),
          Activate: ({ opId }) =>
            Effect.gen(function* activateEffect() {
              const activated = yield* registry().activate(row.id, opId);
              if (activated) {
                yield* Effect.logWarning(
                  `watchdog activated stuck create ${row.id}`
                );
              }
              return done({
                ...base,
                action: action._tag,
                outcome: activated ? "activated" : "row changed",
              });
            }),
          Destroy: () =>
            Effect.gen(function* destroyEffect() {
              yield* finishDelete(row.id);
              yield* Effect.logWarning(
                `watchdog finished stuck delete ${row.id}`
              );
              return done({ ...base, action: action._tag, outcome: "removed" });
            }),
          Refresh: ({ observation, revision, summary }) =>
            Effect.succeed<RowStep>({
              item: { id: row.id, observation, revision, summary },
              report: {
                ...base,
                action: action._tag,
                alarmAt: status?.alarmAt ?? null,
                outcome: "refreshed",
              },
            }),
          Skip: ({ reason }) =>
            Effect.gen(function* skipEffect() {
              yield* Effect.logWarning(`watchdog skipped ${row.id}: ${reason}`);
              return done({ ...base, action: action._tag, outcome: reason });
            }),
          Wait: () =>
            Effect.succeed(
              done({ ...base, action: action._tag, outcome: "waiting" })
            ),
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`watchdog failed for ${row.id}`, cause).pipe(
            Effect.as<RowStep>({
              done: {
                action: "Error",
                errors: [describeCause(cause)],
                id: row.id,
                lifecycle: row.lifecycle,
                outcome: "failed",
              },
            })
          )
        )
      );

    const rows = yield* registry().list();
    const steps = yield* Effect.forEach(rows, processRow, {
      concurrency: watchdogConcurrency,
    });
    const items = steps.flatMap((step) => ("item" in step ? [step.item] : []));

    // One batched write for every active monitor (also prunes and re-arms
    // the Registry alarm, so it is made even when there are no items).
    const batch = yield* registry()
      .reconcile(items, now)
      .pipe(
        Effect.map((report: ReconcileReport) => ({ error: null, report })),
        Effect.catchCause((cause) =>
          Effect.logError("watchdog reconcile failed", cause).pipe(
            Effect.as({ error: describeCause(cause), report: null })
          )
        )
      );
    const byId = new Map(
      (batch.report?.results ?? []).map((result) => [result.id, result])
    );

    // Confirm the would-be opens with a fresh read of each monitor, made
    // after the batch: an observation from before it could miss a check or
    // disable the monitor committed but had not pushed yet.
    const suspects = items.filter(
      (item) => byId.get(item.id)?.watch?.change === "suspect"
    );
    const reread = yield* Effect.forEach(
      suspects,
      (suspect) =>
        monitor(suspect.id)
          .status()
          .pipe(
            Effect.map((status) => ({
              confirmed: confirmSuspect(suspect, status, now),
              error: null,
              id: suspect.id,
            })),
            Effect.catchCause((cause) =>
              Effect.logError(
                `watchdog could not confirm ${suspect.id}`,
                cause
              ).pipe(
                Effect.as({
                  confirmed: null,
                  error: describeCause(cause),
                  id: suspect.id,
                })
              )
            )
          ),
      { concurrency: watchdogConcurrency }
    );
    const confirmed = reread.flatMap((entry) =>
      entry.confirmed === null ? [] : [entry.confirmed]
    );
    const confirm =
      confirmed.length === 0
        ? null
        : yield* registry()
            .confirmStale(confirmed, now)
            .pipe(
              Effect.map((report: ConfirmReport) => ({ error: null, report })),
              Effect.catchCause((cause) =>
                Effect.logError("watchdog confirmStale failed", cause).pipe(
                  Effect.as({ error: describeCause(cause), report: null })
                )
              )
            );
    const confirmById = new Map(
      (confirm?.report?.results ?? []).map((result) => [result.id, result])
    );
    const rereadById = new Map(reread.map((entry) => [entry.id, entry]));
    const dismissed: ObserveResult = {
      applied: false,
      change: "none",
      episodeId: null,
    };

    /**
     * A suspect's outcome: the confirming write's, or dismissed (the fresh
     * read did not confirm it, or failed).
     */
    const confirmation = (id: string) => {
      const entry = rereadById.get(id);
      if (entry === undefined || entry.confirmed === null) {
        return { error: entry?.error ?? null, watch: dismissed };
      }
      const result = confirmById.get(id);
      return {
        error:
          result?.error ?? confirm?.error ?? (result ? null : "not confirmed"),
        watch: result?.watch ?? dismissed,
      };
    };

    const results = steps.map((step): RowReport => {
      if ("done" in step) {
        return step.done;
      }
      const result = byId.get(step.item.id);
      const error =
        result?.error ?? batch.error ?? (result ? null : "not reconciled");
      const errors = error === null ? [] : [`reconcile: ${error}`];
      const report: RowReport = {
        ...step.report,
        errors,
        outcome: error === null ? "refreshed" : "partly failed",
        summaryUpdated: result?.summaryUpdated ?? false,
      };
      if (result?.watch?.change === "suspect") {
        const outcome = confirmation(step.item.id);
        return outcome.error === null
          ? { ...report, suspect: true, watch: outcome.watch }
          : {
              ...report,
              errors: [...errors, `confirm: ${outcome.error}`],
              outcome: "partly failed",
              suspect: true,
              watch: outcome.watch,
            };
      }
      return result?.watch ? { ...report, watch: result.watch } : report;
    });

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
      pruned: batch.report?.pruned ?? null,
      // The confirming write re-armed the alarm last, when it was made.
      registryAlarmAt:
        confirm?.report?.alarmAt ?? batch.report?.alarmAt ?? null,
      results,
    } satisfies WatchdogReport;
  }
);
