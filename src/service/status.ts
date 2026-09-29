import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { displayStatus } from "../domain/monitor.ts";
import type {
  PublicMonitor,
  PublicMonitorStatus,
  PublicStatus,
} from "../domain/public-status.ts";
import { PublicDay, overallStatus } from "../domain/public-status.ts";
import { Monitor } from "../monitor/monitor.ts";
import type { RegistryEntry } from "../registry/registry.ts";
import { Registry, registryName } from "../registry/registry.ts";

/** Days of history on the status page. */
export const statusHistoryDays = 90;
/** How long a monitor's history stays in the Cache API. */
export const statusCacheSeconds = 300;

/** A monitor's cached history for the status page. */
export const PublicHistory = Schema.Struct({
  days: Schema.Array(PublicDay),
  uptimePercent: Schema.NullOr(Schema.Number),
});
export type PublicHistory = typeof PublicHistory.Type;

/** Per-monitor history cache, keyed by monitor id. */
export interface HistoryCache {
  readonly get: (id: string) => Effect.Effect<PublicHistory | null>;
  readonly set: (id: string, history: PublicHistory) => Effect.Effect<void>;
}

interface CacheLike {
  readonly match: (
    key: string
  ) => Promise<{ readonly text: () => Promise<string> } | undefined>;
  readonly put: (key: string, response: Response) => Promise<void>;
}

const cacheKey = (id: string) =>
  `https://kanshi.cache/status-history/v1/${encodeURIComponent(id)}`;

const decodeHistory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PublicHistory)
);

/**
 * The Workers Cache API (`caches.default`), 5 minutes per entry. Only
 * history is cached, never which monitors are public. Where there is no
 * Cache API (tests), nothing is cached. Cache failures are ignored.
 */
export const workersHistoryCache = (): HistoryCache => {
  // SAFETY: the Workers runtime defines `caches.default` as a Cache, whose
  // `match`/`put` are a superset of `CacheLike`; both are optional here and
  // their absence (Node, Bun) is checked below.
  const { caches } = globalThis as { caches?: { default?: CacheLike } };
  const cache = caches?.default;
  if (cache === undefined) {
    return { get: () => Effect.succeed(null), set: () => Effect.void };
  }
  return {
    get: (id) =>
      Effect.tryPromise(() => cache.match(cacheKey(id))).pipe(
        Effect.flatMap((response) =>
          response === undefined
            ? Effect.succeed(null)
            : Effect.tryPromise(() => response.text()).pipe(
                Effect.flatMap(decodeHistory)
              )
        ),
        Effect.orElseSucceed(() => null)
      ),
    set: (id, history) =>
      Effect.tryPromise(() =>
        cache.put(
          cacheKey(id),
          Response.json(history, {
            headers: { "cache-control": `max-age=${statusCacheSeconds}` },
          })
        )
      ).pipe(Effect.ignore),
  };
};

export interface StatusDeps {
  readonly cache: HistoryCache;
  readonly monitors: Effect.Success<typeof Monitor>;
  readonly registries: Effect.Success<typeof Registry>;
}

const publicStatusOf = (entry: RegistryEntry): PublicMonitorStatus =>
  displayStatus(entry.summary);

const emptyHistory: PublicHistory = { days: [], uptimePercent: null };

/**
 * The public status: every request reads which monitors are public from
 * the Registry (so a monitor made private disappears at once); only each
 * monitor's daily history comes from the cache.
 */
export const makeStatusService = (deps: StatusDeps) => {
  const registry = () => deps.registries.getByName(registryName);
  const monitor = (id: string) => deps.monitors.getByName(id);

  const history = (id: string) =>
    Effect.gen(function* historyEffect() {
      const cached = yield* deps.cache.get(id);
      if (cached !== null) {
        return cached;
      }
      const report = yield* monitor(id).uptime(statusHistoryDays);
      const fresh: PublicHistory = {
        days: report.days.map((day): PublicDay => ({
          day: day.day,
          partial: day.partial,
          uptimePercent: day.uptimePercent,
        })),
        uptimePercent: report.uptimePercent,
      };
      yield* deps.cache.set(id, fresh);
      return fresh;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`status history of ${id} failed`, cause).pipe(
          Effect.as(emptyHistory)
        )
      )
    );

  /** Start of the open incident of a monitor that is down (read live). */
  const downSince = (entry: RegistryEntry) =>
    publicStatusOf(entry) === "down"
      ? monitor(entry.id)
          .incidents(5)
          .pipe(
            Effect.map(
              (incidents) =>
                incidents.find((incident) => incident.resolvedAt === null)
                  ?.startedAt ?? null
            ),
            Effect.catchCause(() => Effect.succeed(null))
          )
      : Effect.succeed(null);

  const publicStatus = () =>
    Effect.gen(function* publicStatusEffect() {
      const entries = (yield* registry().list()).filter(
        (entry) => entry.lifecycle === "active" && entry.public
      );
      const monitors = yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.all({
            downSince: downSince(entry),
            history: history(entry.id),
          }).pipe(
            Effect.map((loaded): PublicMonitor => ({
              days: loaded.history.days,
              downSince: loaded.downSince,
              lastCheckedAt: entry.summary.lastCheckedAt,
              name: entry.summary.name,
              status: publicStatusOf(entry),
              uptimePercent: loaded.history.uptimePercent,
            }))
          ),
        { concurrency: 8 }
      );
      return {
        generatedAt: Date.now(),
        monitors,
        overall: overallStatus(monitors),
      } satisfies PublicStatus;
    });

  return { publicStatus };
};

/**
 * The public status as a service, built from the Worker's context, with
 * the history cached in the Workers Cache API.
 */
export class StatusService extends Context.Service<
  StatusService,
  ReturnType<typeof makeStatusService>
>()("kanshi/service/StatusService") {
  static readonly layer = Layer.effect(
    StatusService,
    Effect.gen(function* StatusServiceLayer() {
      return makeStatusService({
        cache: workersHistoryCache(),
        monitors: yield* Monitor,
        registries: yield* Registry,
      });
    })
  );
}
