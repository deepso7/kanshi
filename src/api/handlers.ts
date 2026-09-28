import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { buildConfig } from "../domain/monitor-input.ts";
import type { ChannelSelection, MonitorSnapshot } from "../domain/monitor.ts";
import { summaryOf } from "../domain/monitor.ts";
import { initialState } from "../monitor/cycle.ts";
import type { Monitor } from "../monitor/monitor.ts";
import type { Registry, RegistryEntry } from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";
import type { MonitorListItem, MonitorResponse } from "./spec.ts";
import { BadRequest, Conflict, KanshiApi, NotFound } from "./spec.ts";

export interface ApiDeps {
  readonly devMode: boolean;
  readonly monitors: Effect.Success<typeof Monitor>;
  readonly quota: number;
  readonly registries: Effect.Success<typeof Registry>;
}

/** Dev stage only: delay between `registry.begin` and `configure`. */
export const devConfigureDelayHeader = "x-kanshi-dev-configure-delay";

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

export const makeMonitorsHandlers = (deps: ApiDeps) => {
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

  return HttpApiBuilder.group(KanshiApi, "monitors", (handlers) =>
    handlers
      .handle("list", () =>
        registry()
          .list()
          .pipe(
            Effect.map((entries) =>
              entries
                .filter((entry) => entry.lifecycle === "active")
                .map(toListItem)
            )
          )
      )
      .handle("create", ({ payload, request }) =>
        Effect.gen(function* createMonitor() {
          const id = crypto.randomUUID();
          const now = Date.now();
          const built = buildConfig(id, payload, {
            devMode: deps.devMode,
            now,
          });
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

          const delayMs = Number(request.headers[devConfigureDelayHeader]);
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

          const activated = yield* registry().activate(id, opId);
          if (!activated) {
            return yield* new Conflict({
              message: `monitor ${id} was deleted while being created`,
            });
          }
          return toResponse({ public: isPublic }, snapshot);
        })
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* getMonitor() {
          const entry = yield* activeEntry(params.id);
          const snapshot = yield* monitor(params.id)
            .snapshot()
            .pipe(Effect.mapError(() => notFound(params.id)));
          return toResponse(entry, snapshot);
        })
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* updateMonitor() {
          const entry = yield* activeEntry(params.id);
          yield* checkChannels(payload.channels);
          const snapshot = yield* monitor(params.id)
            .update(payload, { devMode: deps.devMode })
            .pipe(
              Effect.catchTags({
                InvalidMonitorInput: (error) =>
                  Effect.fail(new BadRequest({ message: error.message })),
                MonitorNotConfigured: () => Effect.fail(notFound(params.id)),
                MonitorTombstoned: () => Effect.fail(notFound(params.id)),
              })
            );
          if (payload.public !== undefined && payload.public !== entry.public) {
            const updated = yield* registry().setPublic(
              params.id,
              payload.public
            );
            if (!updated) {
              return yield* notFound(params.id);
            }
            return toResponse({ public: payload.public }, snapshot);
          }
          return toResponse(entry, snapshot);
        })
      )
      .handle("remove", ({ params }) =>
        removeMonitor(params.id, null).pipe(
          Effect.flatMap((removed) =>
            removed ? Effect.void : Effect.fail(notFound(params.id))
          )
        )
      )
      .handle("check", ({ params }) =>
        Effect.gen(function* checkMonitor() {
          const entry = yield* activeEntry(params.id);
          const snapshot = yield* monitor(params.id)
            .runNow()
            .pipe(
              Effect.catchTags({
                MonitorDisabled: () =>
                  Effect.fail(
                    new Conflict({
                      message: `monitor ${params.id} is disabled`,
                    })
                  ),
                MonitorNotConfigured: () => Effect.fail(notFound(params.id)),
                MonitorTombstoned: () => Effect.fail(notFound(params.id)),
              })
            );
          return toResponse(entry, snapshot);
        })
      )
  );
};
