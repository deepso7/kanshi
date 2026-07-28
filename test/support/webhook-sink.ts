import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Database } from "../../src/db/client.ts";

export default class WebhookSink extends Cloudflare.Worker<WebhookSink>()(
  "KanshiWebhookSink",
  { main: import.meta.url },
  Effect.gen(function* WebhookSinkInit() {
    const database = yield* Database;
    const d1 = yield* Cloudflare.D1.QueryDatabase(database);

    return {
      fetch: Effect.gen(function* WebhookRequest() {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "https://webhook.test");

        if (
          request.method === "POST" &&
          url.pathname === "/configure" &&
          request.headers["x-kanshi-test"] === "integration"
        ) {
          const body = (yield* request.json) as { webhookDelayMs?: number };
          yield* d1
            .prepare(
              `UPDATE test_fixture_config
               SET webhook_delay_ms = coalesce(?, webhook_delay_ms)
               WHERE id = 1`
            )
            .bind(body.webhookDelayMs ?? null)
            .run();
          return HttpServerResponse.empty();
        }

        if (request.method === "POST") {
          const body = yield* request.json;
          yield* d1
            .prepare(
              `INSERT INTO test_webhook_events (body, received_at)
               VALUES (?, ?)`
            )
            .bind(JSON.stringify(body), Date.now())
            .run();
          const config = yield* d1
            .prepare(
              `SELECT webhook_delay_ms
               FROM test_fixture_config WHERE id = 1`
            )
            .first<{ webhook_delay_ms: number }>();
          if (config && config.webhook_delay_ms > 0) {
            yield* Effect.sleep(config.webhook_delay_ms);
          }
          return HttpServerResponse.text("ok");
        }

        if (request.headers["x-kanshi-test"] !== "integration") {
          return HttpServerResponse.empty({ status: 401 });
        }

        if (request.method === "GET" && url.pathname === "/events") {
          const result = yield* d1
            .prepare(
              `SELECT body, received_at
               FROM test_webhook_events ORDER BY id`
            )
            .all<{ body: string; received_at: number }>();
          return yield* HttpServerResponse.json({
            events: result.results.map((event) => ({
              body: JSON.parse(event.body) as unknown,
              receivedAt: event.received_at,
            })),
          });
        }

        return HttpServerResponse.empty({ status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 })
          )
        )
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
) {}
