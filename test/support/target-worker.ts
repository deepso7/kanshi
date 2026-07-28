import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class TargetWorker extends Cloudflare.Worker<TargetWorker>()(
  "KanshiTargetWorker",
  { main: import.meta.url },
  Effect.succeed({
    fetch: Effect.gen(function* TargetRequest() {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "https://target.test");
      if (request.method !== "GET" || url.pathname !== "/target") {
        return HttpServerResponse.empty({ status: 404 });
      }

      const delayMs = Number(url.searchParams.get("delay") ?? 0);
      const status = Number(url.searchParams.get("status") ?? 200);
      if (delayMs > 0) {
        yield* Effect.sleep(delayMs);
      }
      return HttpServerResponse.text(status === 200 ? "ok" : "down", {
        status,
      });
    }),
  })
) {}
