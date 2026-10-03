import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { ChannelService } from "../service/channels.ts";
import { KanshiApi } from "./spec.ts";

/** The `channels` group, over the contextual {@link ChannelService}. */
export const ChannelsHandlers = HttpApiBuilder.group(
  KanshiApi,
  "channels",
  Effect.fnUntraced(function* channelsHandlers(handlers) {
    const service = yield* ChannelService;
    return handlers
      .handle("list", () => service.list())
      .handle("create", ({ payload }) => service.create(payload))
      .handle("update", ({ params, payload }) =>
        service.update(params.id, payload)
      )
      .handle("test", ({ params }) => service.test(params.id))
      .handle("remove", ({ params }) => service.remove(params.id));
  })
);
