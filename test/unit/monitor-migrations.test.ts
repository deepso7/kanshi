// Upgrades a populated Monitor through its real migration list, run by the
// same client and migrator the Durable Object uses, over Node's built-in
// SQLite instead of the object's storage.
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { MonitorConfig } from "../../src/domain/monitor.ts";
import {
  incidentExcerpt,
  listIncidents,
  monitorMigrationRecord,
  openIncident,
  readConfig,
  readIncident,
} from "../../src/monitor/storage.ts";
import { clientLayer, columns, migrate, rows } from "./local-sqlite.ts";

describe("Monitor migrations", () => {
  it.effect("schedule maintenance now for version 2 Monitors", () =>
    Effect.gen(function* historyMigrationTest() {
      const db = new DatabaseSync(":memory:");
      yield* migrate(db, monitorMigrationRecord, 2);
      db.exec(`INSERT INTO config (singleton, id, key, managed, name, url,
          method, expected_status, body_contains, timeout_ms,
          interval_seconds, failure_threshold, success_threshold, enabled,
          channels, generation, created_at, updated_at)
        VALUES (1, 'm1', 'site', 1, 'Site', 'https://example.com/', 'GET',
          '2xx', NULL, 10000, 60, 2, 1, 1, '[]', 1, 100, 1000)`);
      db.exec(`INSERT INTO state (singleton, status, failure_streak,
          success_streak, last_checked_at, last_result, open_incident_id,
          next_check_at, next_check_kind, next_slot_at, confirm_counted,
          manual_requested_at, inflight, summary_revision,
          next_maintenance_at, rolled_up_through)
        VALUES (1, 'up', 0, 1, 5000, NULL, NULL, 65000, 'scheduled', 65000,
          0, NULL, NULL, 1, NULL, NULL)`);

      // The applied migration reads the wall clock (Date.now), not Clock.
      const before = Date.now();
      yield* migrate(db, monitorMigrationRecord, 3);
      const after = Date.now();
      const scheduled = rows(db, "SELECT next_maintenance_at FROM state")[0]
        ?.next_maintenance_at;
      assert.isAtLeast(Number(scheduled), before);
      assert.isAtMost(Number(scheduled), after);
      assert.deepStrictEqual(rows(db, "SELECT * FROM enabled_periods"), [
        { ended_at: null, id: 1, interval_seconds: 60, started_at: 100 },
      ]);
      db.close();
    })
  );

  it.effect("upgrade a populated version 4 Monitor, keeping its data", () =>
    Effect.gen(function* upgradeTest() {
      const db = new DatabaseSync(":memory:");
      const applied = yield* migrate(db, monitorMigrationRecord, 4);
      assert.deepStrictEqual(
        applied.map(([id]) => id),
        [1, 2, 3, 4]
      );
      assert.includeMembers([...columns(db, "config")], ["key", "managed"]);

      // A version 4 Monitor in use: configured by config sync, down, with
      // an open incident, its checks and a queued alert.
      db.exec(`INSERT INTO config (singleton, id, key, managed, name, url,
          method, expected_status, body_contains, timeout_ms,
          interval_seconds, failure_threshold, success_threshold, enabled,
          channels, generation, created_at, updated_at)
        VALUES (1, 'm1', 'site', 1, 'Site', 'https://example.com/', 'GET',
          '2xx', 'ok', 10000, 60, 2, 1, 1, '["c1"]', 3, 100, 1000)`);
      db.exec(`INSERT INTO state (singleton, status, failure_streak,
          success_streak, last_checked_at, last_result, open_incident_id,
          next_check_at, next_check_kind, next_slot_at, confirm_counted,
          manual_requested_at, inflight, summary_revision,
          next_maintenance_at, rolled_up_through, schedule_reset_at)
        VALUES (1, 'down', 2, 0, 5000, NULL, 'i1', 65000, 'scheduled',
          65000, 0, NULL, NULL, 7, 90000, NULL, 1000)`);
      db.exec(`INSERT INTO checks (check_id, at, kind, counted, ok, status,
          latency_ms, error_kind, message)
        VALUES ('k1', 5000, 'scheduled', 1, 0, 500, 120, 'status',
          'HTTP 500')`);
      db.exec(`INSERT INTO incidents (id, started_at, resolved_at,
          resolution, cause, last_http_status)
        VALUES ('i1', 5000, NULL, NULL, 'HTTP 500', 500)`);
      db.exec(`INSERT INTO outbox (incident_id, event, channel_id, state,
          attempts, next_attempt_at, last_error, combined, created_at,
          updated_at)
        VALUES ('i1', 'down', 'c1', 'pending', 1, 6000, 'timeout', 0, 5000,
          5500)`);
      const kept = ["state", "checks", "incidents", "outbox"] as const;
      const before = kept.map((table) => rows(db, `SELECT * FROM ${table}`));

      const upgraded = yield* migrate(db, monitorMigrationRecord, 5);
      assert.deepStrictEqual(
        upgraded.map(([id, name]) => `${id}_${name}`),
        ["5_drop_key_managed"]
      );
      assert.notInclude([...columns(db, "config")], "key");
      assert.notInclude([...columns(db, "config")], "managed");
      assert.deepStrictEqual(
        kept.map((table) => rows(db, `SELECT * FROM ${table}`)),
        before
      );

      // The Monitor reads its configuration from the upgraded schema.
      const config = yield* readConfig.pipe(Effect.provide(clientLayer(db)));
      assert.deepStrictEqual(config, {
        bodyContains: "ok",
        channels: ["c1"],
        createdAt: 100,
        enabled: true,
        expectedStatus: "2xx",
        failureThreshold: 2,
        generation: 3,
        id: "m1",
        intervalSeconds: 60,
        method: "GET",
        name: "Site",
        successThreshold: 1,
        timeoutMs: 10_000,
        updatedAt: 1000,
        url: "https://example.com/",
      } satisfies MonitorConfig);

      // Applied migrations are skipped on the next activation.
      assert.deepStrictEqual(yield* migrate(db, monitorMigrationRecord, 5), []);
      db.close();
    })
  );

  it.effect("add the opening check's excerpt and latency to incidents", () =>
    Effect.gen(function* excerptMigrationTest() {
      const db = new DatabaseSync(":memory:");
      yield* migrate(db, monitorMigrationRecord, 5);
      db.exec(`INSERT INTO incidents (id, started_at, resolved_at,
          resolution, cause, last_http_status)
        VALUES ('i1', 5000, 9000, 'recovered', 'expected 2xx, got 500', 500)`);
      const before = rows(db, "SELECT * FROM incidents");

      const upgraded = yield* migrate(
        db,
        monitorMigrationRecord,
        Number.POSITIVE_INFINITY
      );
      assert.deepStrictEqual(
        upgraded.map(([id, name]) => `${id}_${name}`),
        ["6_incident_excerpt"]
      );
      assert.includeMembers(
        [...columns(db, "incidents")],
        ["latency_ms", "response_excerpt", "response_truncated"]
      );
      // The old incident is kept, with nothing known about its body.
      assert.deepStrictEqual(rows(db, "SELECT * FROM incidents"), [
        {
          ...before[0],
          latency_ms: null,
          response_excerpt: null,
          response_truncated: 0,
        },
      ]);

      const client = clientLayer(db);
      const old = yield* readIncident("i1").pipe(Effect.provide(client));
      assert.strictEqual(old?.latencyMs, null);
      assert.isNull(old === null ? "missing" : incidentExcerpt(old));

      // A new incident stores what its opening check saw.
      const excerpt = { text: '{"ok":false}', truncated: true };
      yield* openIncident({
        cause: "expected 2xx, got 503",
        id: "i2",
        lastHttpStatus: 503,
        latencyMs: 412,
        responseExcerpt: excerpt,
        startedAt: 10_000,
      }).pipe(Effect.provide(client));
      const stored = yield* readIncident("i2").pipe(Effect.provide(client));
      assert.deepStrictEqual(stored, {
        cause: "expected 2xx, got 503",
        id: "i2",
        lastHttpStatus: 503,
        latencyMs: 412,
        resolution: null,
        resolvedAt: null,
        responseExcerpt: '{"ok":false}',
        responseTruncated: true,
        startedAt: 10_000,
      });
      assert.deepStrictEqual(
        stored === null ? null : incidentExcerpt(stored),
        excerpt
      );
      // The API's incident list leaves the alert-only columns out.
      const listed = yield* listIncidents(10).pipe(Effect.provide(client));
      assert.deepStrictEqual(
        listed.map((incident) => Object.keys(incident).toSorted()),
        [
          [
            "cause",
            "id",
            "lastHttpStatus",
            "resolution",
            "resolvedAt",
            "startedAt",
          ],
          [
            "cause",
            "id",
            "lastHttpStatus",
            "resolution",
            "resolvedAt",
            "startedAt",
          ],
        ]
      );
      db.close();
    })
  );
});
