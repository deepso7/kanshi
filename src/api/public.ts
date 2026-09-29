import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { StatusService } from "../service/status.ts";
import { KanshiApi } from "./spec.ts";

/**
 * `GET /api/public/status`: never cached (it must drop a monitor made
 * private at once) and readable from any origin.
 */
export const PublicHandlers = HttpApiBuilder.group(
  KanshiApi,
  "public",
  Effect.fnUntraced(function* publicHandlers(handlers) {
    const service = yield* StatusService;
    return handlers.handle("status", () =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(
          HttpServerResponse.setHeaders(response, {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          })
        )
      ).pipe(Effect.andThen(service.publicStatus()))
    );
  })
);
