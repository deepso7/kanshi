import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { BadRequest, Conflict, NotFound } from "../api/spec.ts";
import type { MonitorListItem, MonitorResponse } from "../api/spec.ts";
import type {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../domain/monitor-input.ts";
import { buildConfig } from "../domain/monitor-input.ts";
import type { ChannelSelection, MonitorSnapshot } from "../domain/monitor.ts";
import { summaryOf } from "../domain/monitor.ts";
import { initialState } from "../monitor/cycle.ts";
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

/**
 * The monitor operations shared by the `/api` handlers and the dashboard:
 * the create and delete flows over the Registry and the Monitor objects,
 * and the reads. Failures are the API's `BadRequest | Conflict | NotFound`.
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
          Effect.catchCause((cause) =>
            // Abandon the create; if the row is no longer ours, a
            // concurrent delete already cleaned up.
            removeMonitor(id, opId).pipe(
              Effect.ignore,
              Effect.andThen(Effect.logWarning("create failed", cause)),
              Effect.andThen(
                Effect.fail(
                  new Conflict({
                    message: `monitor ${id} was deleted while being created`,
                  })
                )
              )
            )
          )
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
   * Apply a patch to the monitor, then write `public` synchronously to the
   * Registry, so the status page stops showing a monitor made private as
   * soon as this returns.
   */
  const update = (id: string, patch: MonitorPatchInput) =>
    Effect.gen(function* updateMonitor() {
      const entry = yield* activeEntry(id);
      yield* checkChannels(patch.channels);
      const snapshot = yield* monitor(id)
        .update(patch, { devMode: deps.devMode })
        .pipe(
          Effect.catchTags({
            InvalidMonitorInput: (error) =>
              Effect.fail(new BadRequest({ message: error.message })),
            MonitorNotConfigured: () => Effect.fail(notFound(id)),
            MonitorTombstoned: () => Effect.fail(notFound(id)),
          })
        );
      if (patch.public !== undefined && patch.public !== entry.public) {
        const updated = yield* registry().setPublic(id, patch.public);
        if (!updated) {
          return yield* notFound(id);
        }
        return toResponse({ public: patch.public }, snapshot);
      }
      return toResponse(entry, snapshot);
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

  return {
    activeEntry,
    check,
    checks,
    create,
    get,
    incidents,
    list,
    remove,
    toListItem,
    update,
    uptime,
  };
};

export type MonitorService = ReturnType<typeof makeMonitorService>;
