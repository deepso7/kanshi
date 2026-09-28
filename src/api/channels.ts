import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { deliver } from "../alerts/delivery.ts";
import { alertRequest } from "../alerts/message.ts";
import { checkChannelUrl, hashUrl } from "../domain/channel.ts";
import type { ChannelRecordPatch, Registry } from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";
import type { ChannelTestResult } from "./spec.ts";
import { BadRequest, Conflict, KanshiApi, NotFound } from "./spec.ts";

export interface ChannelsDeps {
  readonly devMode: boolean;
  readonly registries: Effect.Success<typeof Registry>;
}

const notFound = (id: string) =>
  new NotFound({ message: `channel ${id} not found` });

/** Validate and normalise a channel URL and hash it. */
const secretUrl = (url: string, devMode: boolean) =>
  Effect.gen(function* secretUrlEffect() {
    const checked = checkChannelUrl(url, { devMode });
    if (Result.isFailure(checked)) {
      return yield* new BadRequest({ message: checked.failure });
    }
    return { url: checked.success, urlHash: yield* hashUrl(checked.success) };
  });

export const makeChannelsHandlers = (deps: ChannelsDeps) => {
  const registry = () => deps.registries.getByName(registryName);

  return HttpApiBuilder.group(KanshiApi, "channels", (handlers) =>
    handlers
      .handle("list", () => registry().listChannels())
      .handle("create", ({ payload }) =>
        Effect.gen(function* createChannel() {
          const secret = yield* secretUrl(payload.url, deps.devMode);
          const id = crypto.randomUUID();
          return yield* registry()
            .createChannel({
              id,
              key: payload.key ?? id,
              kind: payload.kind,
              managed: payload.managed ?? false,
              name: payload.name,
              ...secret,
            })
            .pipe(
              Effect.catchTag("KeyTaken", (error) =>
                Effect.fail(
                  new Conflict({
                    message: `a channel with key "${error.key}" already exists`,
                  })
                )
              )
            );
        })
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* updateChannel() {
          const secret =
            payload.url === undefined
              ? {}
              : yield* secretUrl(payload.url, deps.devMode);
          const patch: ChannelRecordPatch = {
            ...(payload.kind === undefined ? {} : { kind: payload.kind }),
            ...(payload.managed === undefined
              ? {}
              : { managed: payload.managed }),
            ...(payload.name === undefined ? {} : { name: payload.name }),
            ...secret,
          };
          const updated = yield* registry().updateChannel(params.id, patch);
          return updated ?? (yield* notFound(params.id));
        })
      )
      .handle("test", ({ params }) =>
        Effect.gen(function* testChannel() {
          const target = yield* registry().channelTarget(params.id);
          if (target === null) {
            return yield* notFound(params.id);
          }
          const result = yield* deliver(
            alertRequest(target.kind, target.url, {
              _tag: "Test",
              channelName: target.name,
              idempotencyKey: `test:${target.id}:${crypto.randomUUID()}`,
              sentAt: Date.now(),
            })
          );
          return (
            result._tag === "Delivered"
              ? { delivered: true, error: null, status: result.status }
              : { delivered: false, error: result.error, status: result.status }
          ) satisfies ChannelTestResult;
        })
      )
      .handle("remove", ({ params }) =>
        registry()
          .deleteChannel(params.id)
          .pipe(
            Effect.flatMap((removed) =>
              removed ? Effect.void : Effect.fail(notFound(params.id))
            )
          )
      )
  );
};
