import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { NotFound } from "../api/spec.ts";
import type { DevEventView } from "../api/spec.ts";
import type { DevEvent } from "../registry/registry.ts";
import { Registry, registryName } from "../registry/registry.ts";
import { KanshiSettings } from "../settings.ts";

export interface DevServiceDeps {
  readonly devMode: boolean;
  readonly registries: Effect.Success<typeof Registry>;
}

/** The fields of a recorded sink request the dashboard shows. */
const SinkDetail = Schema.Struct({
  body: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  respondedWith: Schema.optionalKey(Schema.Number),
});
const decodeSinkDetail = Schema.decodeUnknownOption(SinkDetail);

/** A JSON alert body's candidate message fields (Slack, Discord, webhook). */
const AlertBody = Schema.fromJsonString(
  Schema.Struct({
    content: Schema.optionalKey(Schema.Json),
    text: Schema.optionalKey(Schema.Json),
    title: Schema.optionalKey(Schema.Json),
  })
);
const decodeAlertBody = Schema.decodeUnknownOption(AlertBody);

/** The longest message kept for display. */
const maxMessageLength = 240;

/**
 * The alert's text: `text`, `content` or `title` of a JSON body, else the
 * body itself (ntfy), on one line and at most 240 characters.
 */
export const sinkMessage = (body: string): string => {
  const text = decodeAlertBody(body).pipe(
    Option.flatMap((parsed) =>
      Option.fromUndefinedOr(
        [parsed.text, parsed.content, parsed.title].find(Predicate.isString)
      )
    ),
    Option.getOrElse(() => body)
  );
  return text.replaceAll("\n", " · ").slice(0, maxMessageLength);
};

/** A recorded dev event as the API shows it. */
export const devEventView = (event: DevEvent): DevEventView => {
  const detail = Option.getOrUndefined(decodeSinkDetail(event.detail));
  return {
    at: event.at,
    detail: event.detail,
    id: event.id,
    kind: event.kind,
    message: sinkMessage(detail?.body ?? ""),
    query: detail?.query ?? null,
    respondedWith: detail?.respondedWith ?? null,
  };
};

/**
 * Dev stage reads for the dashboard. Outside dev mode every operation
 * fails with `NotFound`, as if it did not exist.
 */
export const makeDevService = (deps: DevServiceDeps) => {
  const registry = () => deps.registries.getByName(registryName);

  /** The webhook sink's latest `limit` events, newest first. */
  const events = (limit: number) =>
    deps.devMode
      ? registry()
          .devEvents()
          .pipe(
            Effect.map((all) =>
              all.slice(-limit).toReversed().map(devEventView)
            )
          )
      : Effect.fail(new NotFound({ message: "not in dev mode" }));

  return { events };
};

/** The dev stage reads as a service, built from the Worker's context. */
export class DevService extends Context.Service<
  DevService,
  ReturnType<typeof makeDevService>
>()("kanshi/service/DevService") {
  static readonly layer = Layer.effect(
    DevService,
    Effect.gen(function* DevServiceLayer() {
      const { devMode } = yield* KanshiSettings;
      return makeDevService({ devMode, registries: yield* Registry });
    })
  );
}
