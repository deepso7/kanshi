import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { DeliveryResult, deliver } from "../alerts/delivery.ts";
import { AlertMessage, alertRequest } from "../alerts/message.ts";
import { BadRequest, Conflict, NotFound } from "../api/spec.ts";
import type { ChannelTestResult } from "../api/spec.ts";
import type {
  ChannelCreateInput,
  ChannelPatchInput,
} from "../domain/channel.ts";
import { checkChannelUrl, hashUrl } from "../domain/channel.ts";
import type { ChannelRecordPatch } from "../registry/registry.ts";
import { Registry, registryName } from "../registry/registry.ts";
import { KanshiSettings } from "../settings.ts";

export interface ChannelServiceDeps {
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

/**
 * The alert channel operations shared by the `/api` handlers and the
 * dashboard. Failures are the API's `BadRequest | Conflict | NotFound`.
 */
export const makeChannelService = (deps: ChannelServiceDeps) => {
  const registry = () => deps.registries.getByName(registryName);

  const create = (payload: ChannelCreateInput) =>
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
    });

  const update = (id: string, payload: ChannelPatchInput) =>
    Effect.gen(function* updateChannel() {
      const secret =
        payload.url === undefined
          ? null
          : yield* secretUrl(payload.url, deps.devMode);
      const patch: {
        -readonly [K in keyof ChannelRecordPatch]: ChannelRecordPatch[K];
      } = {};
      if (payload.kind !== undefined) {
        patch.kind = payload.kind;
      }
      if (payload.managed !== undefined) {
        patch.managed = payload.managed;
      }
      if (payload.name !== undefined) {
        patch.name = payload.name;
      }
      if (secret !== null) {
        patch.url = secret.url;
        patch.urlHash = secret.urlHash;
      }
      const updated = yield* registry().updateChannel(id, patch);
      return updated ?? (yield* notFound(id));
    });

  /** Send a test alert; answers whether or not the channel accepted it. */
  const test = (id: string) =>
    Effect.gen(function* testChannel() {
      const target = yield* registry().channelTarget(id);
      if (target === null) {
        return yield* notFound(id);
      }
      const result = yield* deliver(
        alertRequest(
          target.kind,
          target.url,
          AlertMessage.Test({
            channelName: target.name,
            idempotencyKey: `test:${target.id}:${crypto.randomUUID()}`,
            sentAt: Date.now(),
          })
        )
      );
      return DeliveryResult.$match(result, {
        Delivered: ({ status }) =>
          ({
            delivered: true,
            error: null,
            status,
          }) satisfies ChannelTestResult,
        Failed: ({ error, status }) =>
          ({ delivered: false, error, status }) satisfies ChannelTestResult,
      });
    });

  const remove = (id: string) =>
    registry()
      .deleteChannel(id)
      .pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.void : Effect.fail(notFound(id))
        )
      );

  return {
    create,
    list: () => registry().listChannels(),
    remove,
    test,
    update,
  };
};

/** The alert channel operations as a service, built from the Worker's context. */
export class ChannelService extends Context.Service<
  ChannelService,
  ReturnType<typeof makeChannelService>
>()("kanshi/service/ChannelService") {
  static readonly layer = Layer.effect(
    ChannelService,
    Effect.gen(function* ChannelServiceLayer() {
      const { devMode } = yield* KanshiSettings;
      return makeChannelService({ devMode, registries: yield* Registry });
    })
  );
}
