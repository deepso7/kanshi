import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import ApiWorker from "../src/api/worker.ts";
import { Database } from "../src/db/client.ts";
import HarnessWorker from "./support/harness-worker.ts";
import TargetWorker from "./support/target-worker.ts";
import WebhookSink from "./support/webhook-sink.ts";

export default Alchemy.Stack(
  "KanshiIntegration",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* KanshiIntegrationStack() {
    const database = yield* Database;
    const api = yield* ApiWorker.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            KANSHI_API_TOKEN: "integration-api-token",
            TINYBIRD_READ_TOKEN: "integration-read-token",
            TINYBIRD_URL: "https://api.tinybird.co",
          },
        })
      )
    );
    const harness = yield* HarnessWorker;
    const target = yield* TargetWorker;
    const webhookSink = yield* WebhookSink;

    return {
      apiUrl: api.url.as<string>(),
      databaseName: database.databaseName,
      harnessUrl: harness.url.as<string>(),
      targetUrl: target.url.as<string>(),
      webhookSinkUrl: webhookSink.url.as<string>(),
    };
  })
);
