import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { BadRequest, Conflict, NotFound, Unavailable } from "../api/spec.ts";
import type { MonitorListItem, MonitorResponse } from "../api/spec.ts";
import type {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../domain/monitor-input.ts";
import { buildConfig, patchConfig } from "../domain/monitor-input.ts";
import type { ChannelSelection, MonitorSnapshot } from "../domain/monitor.ts";
import { summaryOf } from "../domain/monitor.ts";
import { initialState } from "../monitor/cycle.ts";
import { recentBuckets, recentWindowMs } from "../monitor/history.ts";
import type { ChecksQuery, Monitor } from "../monitor/monitor.ts";
import type { Registry, RegistryEntry } from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";

export interface MonitorServiceDeps {
  readonly devMode: boolean;
  readonly monitors: Effect.Success<typeof Monitor>;
  readonly quota: number;
  readonly registries: Effect.Success<typeof Registry>;
}

/** Dev stage hooks for a create (ignored outside dev mode). */
export interface CreateOptions {
  /** Delay between `registry.begin` and `configure`. */
  readonly configureDelayMs?: number;
  /** Stop after `configure`, leaving the row `creating`. */
  readonly skipActivate?: boolean;
}

const notFound = (id: string) =>
  new NotFound({ message: `monitor ${id} not found` });

const toResponse = (
  entry: Pick<RegistryEntry, "public">,
  snapshot: MonitorSnapshot
): MonitorResponse => ({
  ...snapshot.config,
  public: entry.public,
  state: snapshot.state,
});

const toListItem = (entry: RegistryEntry): MonitorListItem => ({
  ...entry.summary,
  id: entry.id,
  key: entry.key,
  managed: entry.managed,
  public: entry.public,
});

/** The patch's fields other than `public`, if any. */
const withoutPublic = (patch: MonitorPatchInput): MonitorPatchInput | null => {
  const { public: _public, ...rest } = patch;
  return Object.keys(rest).length > 0 ? rest : null;
};

/**
 * The monitor operations shared by the `/api` handlers and the dashboard:
 * the create and delete flows over the Registry and the Monitor objects,
 * and the reads. Failures are the API's `BadRequest | Conflict | NotFound`
 * (and `Unavailable` for a partly applied update).
 */
export const makeMonitorService = (deps: MonitorServiceDeps) => {
  const registry = () => deps.registries.getByName(registryName);
  const monitor = (id: string) => deps.monitors.getByName(id);

  /** A monitor's explicit channel list must name existing channels. */
  const checkChannels = (channels: ChannelSelection | undefined) =>
    Effect.gen(function* checkChannelsEffect() {
      if (channels === undefined || channels === "all") {
        return;
      }
      const missing = yield* registry().missingChannels(channels);
      if (missing.length > 0) {
        return yield* new BadRequest({
          message: `channels: unknown channel ids ${missing.join(", ")}`,
        });
      }
    });

  /** The Registry row of an existing, fully created monitor. */
  const activeEntry = (id: string) =>
    registry()
      .get(id)
      .pipe(
        Effect.flatMap((entry) =>
          entry?.lifecycle === "active"
            ? Effect.succeed(entry)
            : Effect.fail(notFound(id))
        )
      );

  /**
   * Delete: mark the row `deleting`, tombstone the object, drop the row. A
   * `configure` that arrives later hits the tombstone, so it cannot re-arm
   * the monitor. Re-running it retries a stuck delete.
   */
  const removeMonitor = (id: string, opId: string | null) =>
    Effect.gen(function* removeMonitorEffect() {
      const marked = yield* registry().markDeleting(id, opId);
      if (!marked) {
        return false;
      }
      yield* monitor(id).destroy();
      yield* registry().remove(id);
      return true;
    });

  /** Every fully created monitor, from the Registry's cached summaries. */
  const list = () =>
    registry()
      .list()
      .pipe(
        Effect.map((entries) =>
          entries.filter((entry) => entry.lifecycle === "active")
        )
      );

  const create = (payload: MonitorCreateInput, options: CreateOptions = {}) =>
    Effect.gen(function* createMonitor() {
      const id = crypto.randomUUID();
      const now = Date.now();
      const built = buildConfig(id, payload, { devMode: deps.devMode, now });
      if (Result.isFailure(built)) {
        return yield* new BadRequest({ message: built.failure });
      }
      const config = built.success;
      yield* checkChannels(config.channels);
      const isPublic = payload.public ?? false;

      const { opId } = yield* registry()
        .begin({
          id,
          key: config.key,
          managed: config.managed,
          public: isPublic,
          quota: deps.quota,
          summary: summaryOf(config, initialState(now)),
        })
        .pipe(
          Effect.catchTags({
            KeyTaken: (error) =>
              Effect.fail(
                new Conflict({
                  message: `a monitor with key "${error.key}" already exists`,
                })
              ),
            QuotaExceeded: (error) =>
              Effect.fail(
                new Conflict({
                  message: `monitor quota of ${error.quota} reached`,
                })
              ),
          })
        );

      const delayMs = options.configureDelayMs ?? 0;
      if (deps.devMode && delayMs > 0) {
        yield* Effect.sleep(delayMs);
      }

      const snapshot = yield* monitor(id)
        .configure(config)
        .pipe(
          // Any failure abandons the create through the normal delete path
          // (tombstone, then drop the row), so nothing is left armed or
          // orphaned. If the row is no longer ours, a concurrent delete
          // already cleaned up.
          Effect.onError((cause) =>
            Effect.logWarning("create failed", cause).pipe(
              Effect.andThen(removeMonitor(id, opId)),
              Effect.ignoreCause({
                log: true,
                message: "create cleanup failed",
              })
            )
          ),
          // Only a tombstone means a concurrent delete won the race.
          Effect.catchTag("MonitorTombstoned", () =>
            Effect.fail(
              new Conflict({
                message: `monitor ${id} was deleted while being created`,
              })
            )
          ),
          // Anything else is a server error (500).
          Effect.catchTag("MonitorIdMismatch", (error) => Effect.die(error))
        );

      if (deps.devMode && options.skipActivate === true) {
        return toResponse({ public: isPublic }, snapshot);
      }
      const activated = yield* registry().activate(id, opId);
      if (!activated) {
        return yield* new Conflict({
          message: `monitor ${id} was deleted while being created`,
        });
      }
      return toResponse({ public: isPublic }, snapshot);
    });

  const get = (id: string) =>
    Effect.gen(function* getMonitor() {
      const entry = yield* activeEntry(id);
      const snapshot = yield* monitor(id)
        .snapshot()
        .pipe(Effect.mapError(() => notFound(id)));
      return toResponse(entry, snapshot);
    });

  /**
   * Apply a patch. The writes, in order:
   *
   * 1. `public` to the Registry, first: the Registry owns it (the status
   *    page reads it there), and making a monitor private must take effect
   *    even if the rest of the update fails.
   * 2. The monitor's configuration (a transaction in the Monitor object).
   * 3. `managed` to the Registry (the list and config sync read it there).
   *
   * A patch that would be rejected is checked against a snapshot before
   * step 1, so a 400 changes nothing. Once step 1 has changed `public`,
   * a later failure says so: a concurrent edit that makes the rest invalid
   * in step 2 is a `Conflict` (409), and any other failure is `Unavailable`
   * (503); both tell the client that visibility was already updated and to
   * retry. Every write is idempotent (it sets values, and the configuration
   * is validated against the merged result), so a retry converges. A
   * `NotFound` stays a 404: the monitor was deleted concurrently.
   */
  const update = (id: string, patch: MonitorPatchInput) =>
    Effect.gen(function* updateMonitor() {
      const entry = yield* activeEntry(id);
      yield* checkChannels(patch.channels);
      const rest = withoutPublic(patch);
      const changesPublic =
        patch.public !== undefined && patch.public !== entry.public;

      if (changesPublic && rest !== null) {
        const current = yield* monitor(id)
          .snapshot()
          .pipe(Effect.mapError(() => notFound(id)));
        const checked = patchConfig(current.config, rest, {
          devMode: deps.devMode,
          now: Date.now(),
        });
        if (Result.isFailure(checked)) {
          return yield* new BadRequest({ message: checked.failure });
        }
      }

      if (changesPublic) {
        const updated = yield* registry().setPublic(id, patch.public === true);
        if (!updated) {
          return yield* notFound(id);
        }
      }

      const applyRest = Effect.gen(function* applyRestEffect() {
        const snapshot = yield* monitor(id)
          .update(rest ?? {}, { devMode: deps.devMode })
          .pipe(
            Effect.catchTags({
              InvalidMonitorInput: (error) =>
                Effect.fail(new BadRequest({ message: error.message })),
              MonitorNotConfigured: () => Effect.fail(notFound(id)),
              MonitorTombstoned: () => Effect.fail(notFound(id)),
            })
          );
        if (patch.managed !== undefined && patch.managed !== entry.managed) {
          const updated = yield* registry().setManaged(id, patch.managed);
          if (!updated) {
            return yield* notFound(id);
          }
        }
        return snapshot;
      });

      const publicSet = `public was set to ${String(patch.public)}`;
      const snapshot = changesPublic
        ? yield* applyRest.pipe(
            Effect.catchTag("BadRequest", (error) =>
              Effect.fail(
                new Conflict({
                  message: `monitor ${id} changed concurrently: ${publicSet}, but the other changes were not applied (${error.message}); retry them`,
                })
              )
            ),
            Effect.catchDefect((defect) =>
              Effect.logError(
                "update failed after setting public",
                defect
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new Unavailable({
                      message: `monitor ${id}: ${publicSet} but the other changes may not have been applied; retry the request`,
                    })
                  )
                )
              )
            )
          )
        : yield* applyRest;
      return toResponse({ public: patch.public ?? entry.public }, snapshot);
    });

  const remove = (id: string) =>
    removeMonitor(id, null).pipe(
      Effect.flatMap((removed) =>
        removed ? Effect.void : Effect.fail(notFound(id))
      )
    );

  /** Request a check now (coalesced; runs when none is in flight). */
  const check = (id: string) =>
    Effect.gen(function* checkMonitor() {
      const entry = yield* activeEntry(id);
      const snapshot = yield* monitor(id)
        .runNow()
        .pipe(
          Effect.catchTags({
            MonitorDisabled: () =>
              Effect.fail(
                new Conflict({ message: `monitor ${id} is disabled` })
              ),
            MonitorNotConfigured: () => Effect.fail(notFound(id)),
            MonitorTombstoned: () => Effect.fail(notFound(id)),
          })
        );
      return toResponse(entry, snapshot);
    });

  const checks = (id: string, query: ChecksQuery) =>
    activeEntry(id).pipe(Effect.andThen(monitor(id).checks(query)));

  const uptime = (id: string, days: number) =>
    activeEntry(id).pipe(
      Effect.andThen(
        monitor(id)
          .uptime(days)
          .pipe(Effect.mapError(() => notFound(id)))
      )
    );

  const incidents = (id: string, limit: number) =>
    activeEntry(id).pipe(Effect.andThen(monitor(id).incidents(limit)));

  /** The last 24h: counted samples and half-hour latency buckets. */
  const recent = (id: string) =>
    monitor(id).recent(recentWindowMs, recentBuckets);

  return {
    activeEntry,
    check,
    checks,
    create,
    get,
    incidents,
    list,
    recent,
    remove,
    toListItem,
    update,
    uptime,
  };
};

export type MonitorService = ReturnType<typeof makeMonitorService>;
