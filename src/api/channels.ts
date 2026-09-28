import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import type { ChannelService } from "../service/channels.ts";
import { KanshiApi } from "./spec.ts";

export const makeChannelsHandlers = (service: ChannelService) =>
  HttpApiBuilder.group(KanshiApi, "channels", (handlers) =>
    handlers
      .handle("list", () => service.list())
      .handle("create", ({ payload }) => service.create(payload))
      .handle("update", ({ params, payload }) =>
        service.update(params.id, payload)
      )
      .handle("test", ({ params }) => service.test(params.id))
      .handle("remove", ({ params }) => service.remove(params.id))
  );
