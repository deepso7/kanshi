// Phase 1 spike: a singleton "Registry"-like Durable Object using the raw
// alchemy `storage.sql` wrapper. Throwaway code.
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export interface RegistryRow {
  readonly monitorId: string;
  readonly fires: number;
  readonly lastFireAt: number;
}

export class Registry extends Cloudflare.DurableObject<
  Registry,
  {
    recordFire: (
      monitorId: string,
      at: number
    ) => Effect.Effect<number, never, RuntimeContext>;
    list: () => Effect.Effect<RegistryRow[], never, RuntimeContext>;
    whoami: () => Effect.Effect<string, never, RuntimeContext>;
  }
>()("Registry") {}

export const RegistryLive = Registry.make(
  Effect.gen(function* RegistryInit() {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* RegistryInstance() {
      yield* state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS monitors (monitor_id TEXT PRIMARY KEY, fires INTEGER NOT NULL, last_fire_at INTEGER NOT NULL)"
      );

      return {
        list: () =>
          Effect.gen(function* list() {
            const cursor = yield* state.storage.sql.exec<{
              monitor_id: string;
              fires: number;
              last_fire_at: number;
            }>(
              "SELECT monitor_id, fires, last_fire_at FROM monitors ORDER BY monitor_id"
            );
            const rows = yield* cursor.toArray();
            return rows.map((row) => ({
              fires: row.fires,
              lastFireAt: row.last_fire_at,
              monitorId: row.monitor_id,
            }));
          }),
        recordFire: (monitorId: string, at: number) =>
          Effect.gen(function* recordFire() {
            const cursor = yield* state.storage.sql.exec<{ fires: number }>(
              "INSERT INTO monitors (monitor_id, fires, last_fire_at) VALUES (?, 1, ?) ON CONFLICT(monitor_id) DO UPDATE SET fires = fires + 1, last_fire_at = excluded.last_fire_at RETURNING fires",
              monitorId,
              at
            );
            const row = yield* cursor.one();
            return row.fires;
          }),
        whoami: () => Effect.succeed(`registry:${state.id.toString()}`),
      };
    });
  })
);
