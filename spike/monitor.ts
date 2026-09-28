// Phase 1 spike: a per-monitor Durable Object that stores its data with
// `@effect/sql-sqlite-do`, drives itself with its alarm, and calls the
// Registry DO over RPC. Throwaway code.
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { Registry } from "./registry.ts";

export interface MonitorStatus {
  readonly name: string | null;
  readonly intervalMs: number;
  readonly alarmAt: number | null;
  readonly fires: readonly {
    readonly at: number;
    readonly registryCount: number;
  }[];
  readonly migrations: readonly string[];
}

export class Monitor extends Cloudflare.DurableObject<
  Monitor,
  {
    configure: (
      name: string,
      intervalMs: number
    ) => Effect.Effect<MonitorStatus, never, RuntimeContext>;
    arm: (delayMs: number) => Effect.Effect<number, never, RuntimeContext>;
    armFlaky: (
      delayMs: number,
      failures: number
    ) => Effect.Effect<number, never, RuntimeContext>;
    stop: () => Effect.Effect<void, never, RuntimeContext>;
    status: () => Effect.Effect<MonitorStatus, never, RuntimeContext>;
    txFail: () => Effect.Effect<{ rowsAfter: number }, never, RuntimeContext>;
    askRegistry: () => Effect.Effect<string, never, RuntimeContext>;
  }
>()("Monitor") {}

const FireRow = Schema.Struct({
  at: Schema.Number,
  registry_count: Schema.Number,
});

const migrations = SqliteMigrator.fromRecord({
  "1_init": Effect.gen(function* init() {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, interval_ms INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE fires (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, registry_count INTEGER NOT NULL)`;
  }),
});

export const MonitorLive = Monitor.make(
  Effect.gen(function* MonitorInit() {
    const state = yield* Cloudflare.DurableObjectState;
    // Resolved in the outer (init) phase: the RPC stub namespace of the
    // other DO class, bound on the same host Worker.
    const registries = yield* Registry;

    return Effect.gen(function* MonitorInstance() {
      // Build the Effect SQL client over this instance's SQLite storage on
      // the instance scope, then run migrations before any method runs.
      const context = yield* Layer.build(
        SqliteClient.layer({ storage: state.raw.storage })
      );
      const sql = Context.get(context, SqliteClient.SqliteClient);
      const applied = yield* SqliteMigrator.run({ loader: migrations }).pipe(
        Effect.provideContext(context),
        Effect.orDie
      );
      yield* Effect.log(
        `monitor ${state.id.toString()} migrations applied: ${applied.length}`
      );

      const findFires = SqlSchema.findAll({
        Request: Schema.Void,
        Result: FireRow,
        execute: () => sql`SELECT at, registry_count FROM fires ORDER BY id`,
      });

      const readConfig = sql<{
        name: string;
        interval_ms: number;
      }>`SELECT name, interval_ms FROM config WHERE id = 1`.pipe(
        Effect.map((rows) => rows[0])
      );

      const status = Effect.gen(function* status() {
        const config = yield* readConfig;
        const fires = yield* findFires();
        const alarmAt = yield* state.storage.getAlarm();
        const migrationRows = yield* sql<{
          name: string;
        }>`SELECT name FROM effect_sql_migrations ORDER BY migration_id`;
        return {
          alarmAt,
          fires: fires.map((fire) => ({
            at: fire.at,
            registryCount: fire.registry_count,
          })),
          intervalMs: config?.interval_ms ?? 0,
          migrations: migrationRows.map((row) => row.name),
          name: config?.name ?? null,
        } satisfies MonitorStatus;
      }).pipe(Effect.orDie);

      const alarm = Effect.fn("Monitor.alarm")(function* alarm(
        info?: Cloudflare.AlarmInvocationInfo
      ) {
        const now = Date.now();
        // Failure-injection: die while `flaky` > 0 so workerd retries.
        const flaky = state.storage.kv.get<number>("flaky") ?? 0;
        if (flaky > 0) {
          state.storage.kv.put("flaky", flaky - 1);
          yield* Effect.log(
            `alarm dying on purpose (retryCount ${info?.retryCount ?? 0}, left ${flaky - 1})`
          );
          return yield* Effect.die(new Error("injected alarm failure"));
        }
        const config = yield* readConfig;
        const name = config?.name ?? "unknown";
        // Cross-DO RPC from inside an alarm, outside any transaction.
        const registryCount = yield* registries
          .getByName("registry")
          .recordFire(name, now)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("registry call failed", cause).pipe(Effect.as(-1))
            )
          );
        yield* sql`INSERT INTO fires (at, registry_count) VALUES (${now}, ${registryCount})`;
        yield* Effect.log(
          `alarm fired for ${name} at ${new Date(now).toISOString()} (registry count ${registryCount}, retryCount ${info?.retryCount ?? 0})`
        );
        const intervalMs = config?.interval_ms ?? 0;
        if (intervalMs > 0) {
          yield* state.storage.setAlarm(now + intervalMs);
        }
      });

      return {
        alarm,
        arm: (delayMs: number) =>
          Effect.gen(function* arm() {
            const at = Date.now() + delayMs;
            yield* state.storage.setAlarm(at);
            return at;
          }),
        armFlaky: (delayMs: number, failures: number) =>
          Effect.gen(function* armFlaky() {
            state.storage.kv.put("flaky", failures);
            const at = Date.now() + delayMs;
            yield* state.storage.setAlarm(at);
            return at;
          }),
        askRegistry: () => registries.getByName("registry").whoami(),
        configure: (name: string, intervalMs: number) =>
          Effect.gen(function* configure() {
            yield* sql`INSERT INTO config (id, name, interval_ms) VALUES (1, ${name}, ${intervalMs}) ON CONFLICT(id) DO UPDATE SET name = excluded.name, interval_ms = excluded.interval_ms`;
            if (intervalMs > 0) {
              yield* state.storage.setAlarm(Date.now() + intervalMs);
            }
            return yield* status;
          }).pipe(Effect.orDie),
        status: () => status,
        stop: () =>
          Effect.gen(function* stop() {
            yield* sql`UPDATE config SET interval_ms = 0 WHERE id = 1`;
            yield* state.storage.deleteAlarm();
          }).pipe(Effect.orDie),
        // Insert inside a transaction, then fail: the insert must roll back.
        txFail: () =>
          Effect.gen(function* txFail() {
            yield* sql
              .withTransaction(
                Effect.gen(function* failingTx() {
                  yield* sql`INSERT INTO fires (at, registry_count) VALUES (${-1}, ${-1})`;
                  return yield* Effect.fail("boom" as const);
                })
              )
              .pipe(Effect.ignore);
            const rows = yield* sql<{
              n: number;
            }>`SELECT count(*) AS n FROM fires WHERE at = -1`;
            return { rowsAfter: rows[0]?.n ?? -1 };
          }).pipe(Effect.orDie),
      };
    });
  })
);
