import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { DatabaseClient, makeDatabaseClient } from "../../src/db/client.ts";
import { runEngine } from "../../src/engine/engine.ts";
import { testSchemaSql } from "./schema.ts";

const authorized = (headers: Record<string, string | undefined>): boolean =>
  headers["x-kanshi-test"] === "integration";

export default class HarnessWorker extends Cloudflare.Worker<HarnessWorker>()(
  "KanshiTestHarness",
  {
    main: import.meta.url,
  },
  Effect.gen(function* HarnessWorkerInit() {
    const databaseClient = yield* makeDatabaseClient;

    return {
      // oxlint-disable-next-line eslint/complexity -- the test harness keeps its control routes in one disposable Worker
      fetch: Effect.gen(function* HarnessRequest() {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://kanshi.test");

        if (request.method === "POST" && url.pathname === "/v0/events") {
          const body = yield* request.text;
          const successfulRows = body
            .split("\n")
            .filter((line) => line.length > 0).length;
          return yield* HttpServerResponse.json({
            quarantined_rows: 0,
            successful_rows: successfulRows,
          });
        }

        if (!authorized(request.headers)) {
          return HttpServerResponse.empty({ status: 401 });
        }

        const { d1 } = databaseClient;
        if (request.method === "POST" && url.pathname === "/reset") {
          const raw = yield* d1.raw;
          const statements = testSchemaSql
            .split(";")
            .map((statement) => statement.trim())
            .filter((statement) => statement.length > 0)
            .map((statement) => raw.prepare(statement));
          yield* Effect.promise(() => raw.batch(statements));
          return HttpServerResponse.empty();
        }

        if (request.method === "POST" && url.pathname === "/tick") {
          const origin = request.headers["x-harness-origin"];
          const webhookOrigin = request.headers["x-webhook-origin"];
          if (!origin || !webhookOrigin) {
            return HttpServerResponse.text("missing fixture origin", {
              status: 400,
            });
          }
          const probeDelayMs = Number(request.headers["x-probe-delay-ms"] ?? 0);
          yield* runEngine(
            {
              appendToken: "test",
              baseUrl: origin,
              readToken: "test",
            },
            {
              beforeProbe:
                probeDelayMs > 0 ? () => Effect.sleep(probeDelayMs) : undefined,
              concurrency: 5,
              validateWebhook: (input) =>
                Effect.try({
                  catch: () => new Error("invalid test webhook"),
                  try: () => {
                    const webhook = new URL(input);
                    if (
                      webhook.origin !== webhookOrigin ||
                      webhook.pathname !== "/webhook"
                    ) {
                      throw new Error("untrusted test webhook");
                    }
                    return webhook;
                  },
                }),
            }
          ).pipe(Effect.provideService(DatabaseClient, databaseClient));
          return HttpServerResponse.empty();
        }

        const dueMatch = url.pathname.match(/^\/due\/(?<id>[^/]+)$/u);
        if (request.method === "POST" && dueMatch?.groups?.id) {
          yield* d1
            .prepare("UPDATE monitors SET next_check_at = 0 WHERE id = ?")
            .bind(dueMatch.groups.id)
            .run();
          return HttpServerResponse.empty();
        }

        const bumpMatch = url.pathname.match(
          /^\/bump-revision\/(?<id>[^/]+)$/u
        );
        if (request.method === "POST" && bumpMatch?.groups?.id) {
          yield* d1
            .prepare(
              `UPDATE monitors
               SET revision = revision + 1
               WHERE id = ?`
            )
            .bind(bumpMatch.groups.id)
            .run();
          return HttpServerResponse.empty();
        }

        const channelMatch = url.pathname.match(
          /^\/channel\/(?<monitorId>[^/]+)$/u
        );
        if (request.method === "POST" && channelMatch?.groups?.monitorId) {
          const body = (yield* request.json) as { webhookUrl: string };
          yield* d1
            .prepare(
              `INSERT INTO alert_channels
                (id, monitor_id, kind, webhook_url, enabled)
               VALUES (?, ?, 'slack', ?, 1)`
            )
            .bind(
              crypto.randomUUID(),
              channelMatch.groups.monitorId,
              body.webhookUrl
            )
            .run();
          return HttpServerResponse.empty();
        }

        if (
          request.method === "POST" &&
          url.pathname === "/expire-deliveries"
        ) {
          yield* d1
            .prepare(
              `UPDATE alert_deliveries
               SET state = 'delivering', lease_until = 0`
            )
            .run();
          return HttpServerResponse.empty();
        }

        const seedAlertMatch = url.pathname.match(
          /^\/seed-alert\/(?<monitorId>[^/]+)$/u
        );
        if (request.method === "POST" && seedAlertMatch?.groups?.monitorId) {
          const { monitorId } = seedAlertMatch.groups;
          const incidentId = `${monitorId}:lease-test`;
          const now = Date.now();
          yield* d1
            .prepare(
              `INSERT INTO incidents
                (id, monitor_id, opening_check_id, started_at, cause)
               VALUES (?, ?, 'lease-test', ?, 'lease-test')`
            )
            .bind(incidentId, monitorId, now)
            .run();
          yield* d1
            .prepare(
              `INSERT INTO alert_deliveries
                (incident_id, event_kind, channel_id, state, attempts,
                 max_attempts, lease_until, created_at, updated_at)
               SELECT ?, 'down', id, 'delivering', 0, 6, 0, ?, ?
               FROM alert_channels
               WHERE monitor_id = ? AND enabled = 1`
            )
            .bind(incidentId, now, now, monitorId)
            .run();
          yield* d1
            .prepare("UPDATE monitors SET next_check_at = ? WHERE id = ?")
            .bind(now + 3_600_000, monitorId)
            .run();
          return HttpServerResponse.empty();
        }

        const stateMatch = url.pathname.match(
          /^\/state\/(?<monitorId>[^/]+)$/u
        );
        if (request.method === "GET" && stateMatch?.groups?.monitorId) {
          const { monitorId } = stateMatch.groups;
          const monitor = yield* d1
            .prepare("SELECT * FROM monitors WHERE id = ?")
            .bind(monitorId)
            .first();
          const incidentResult = yield* d1
            .prepare(
              "SELECT * FROM incidents WHERE monitor_id = ? ORDER BY started_at"
            )
            .bind(monitorId)
            .all();
          const deliveryResult = yield* d1
            .prepare(
              `SELECT d.* FROM alert_deliveries d
               JOIN incidents i ON i.id = d.incident_id
               WHERE i.monitor_id = ?
               ORDER BY d.created_at`
            )
            .bind(monitorId)
            .all();
          return yield* HttpServerResponse.json({
            deliveries: deliveryResult.results,
            incidents: incidentResult.results,
            monitor,
          });
        }

        return HttpServerResponse.empty({ status: 404 });
      }).pipe(
        Effect.provideService(DatabaseClient, databaseClient),
        Effect.catchCause((cause) =>
          Effect.logError("Integration harness request failed", cause).pipe(
            Effect.flatMap(() =>
              Effect.succeed(
                HttpServerResponse.text(Cause.pretty(cause), {
                  status: 500,
                })
              )
            )
          )
        )
      ),
    };
  }).pipe(
    Effect.provide([Cloudflare.D1.QueryDatabaseBinding, FetchHttpClient.layer])
  )
) {}
