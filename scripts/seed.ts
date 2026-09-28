// `pnpm seed`: create the channels and monitors in kanshi.dev.config.ts that
// do not exist yet (matched by key) on a running dev stack. Reads KANSHI_API_TOKEN (Bun
// loads .env) and KANSHI_URL (default http://localhost:1337).
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import config from "../kanshi.dev.config.ts";

const Listed = Schema.Array(
  Schema.Struct({ id: Schema.String, key: Schema.String })
);

const seed = Effect.gen(function* seedEffect() {
  const baseUrl = yield* Config.String("KANSHI_URL").pipe(
    Config.withDefault("http://localhost:1337")
  );
  const token = yield* Config.Redacted("KANSHI_API_TOKEN");
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(baseUrl),
        HttpClientRequest.bearerToken(Redacted.value(token))
      )
    ),
    HttpClient.filterStatusOk
  );

  // The dev stack may still be starting.
  const existing = yield* client
    .get("/api/monitors")
    .pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Listed)),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 })
    );
  const keys = new Set(existing.map((monitor) => monitor.key));

  const channelKeys = new Set(
    (yield* client
      .get("/api/channels")
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Listed)))).map(
      (channel) => channel.key
    )
  );
  for (const channel of config.channels ?? []) {
    if (channelKeys.has(channel.key)) {
      yield* Effect.log(`exists: channel ${channel.key}`);
      continue;
    }
    yield* HttpClientRequest.post("/api/channels").pipe(
      HttpClientRequest.bodyJsonUnsafe(channel),
      client.execute
    );
    yield* Effect.log(`created: channel ${channel.key}`);
  }

  for (const monitor of config.monitors) {
    if (keys.has(monitor.key)) {
      yield* Effect.log(`exists: ${monitor.key}`);
      continue;
    }
    yield* HttpClientRequest.post("/api/monitors").pipe(
      HttpClientRequest.bodyJsonUnsafe(monitor),
      client.execute
    );
    yield* Effect.log(`created: ${monitor.key}`);
  }
});

seed.pipe(Effect.provide(FetchHttpClient.layer), BunRuntime.runMain);
