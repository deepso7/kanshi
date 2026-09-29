import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";

import type { DevEvent } from "../../src/registry/registry.ts";
import type { DevServiceDeps } from "../../src/service/dev.ts";
import {
  devEventView,
  makeDevService,
  sinkMessage,
} from "../../src/service/dev.ts";

const sinkEvent = (id: number, body: string): DevEvent => ({
  at: 1000 + id,
  detail: {
    body,
    contentType: "application/json",
    idempotencyKey: `key-${id}`,
    path: "/_dev/webhook",
    query: `?tag=t${id}`,
    respondedWith: 200,
  },
  id,
  kind: "webhook",
});

describe(sinkMessage, () => {
  it("reads Slack's text, Discord's content, else a title", () => {
    assert.strictEqual(sinkMessage('{"text":"slack"}'), "slack");
    assert.strictEqual(sinkMessage('{"content":"discord"}'), "discord");
    assert.strictEqual(sinkMessage('{"title":"hook","id":"x"}'), "hook");
  });

  it("keeps a non-JSON body (ntfy) on one line, truncated", () => {
    assert.strictEqual(sinkMessage("down\nnow"), "down · now");
    assert.strictEqual(sinkMessage("x".repeat(500)).length, 240);
    assert.strictEqual(sinkMessage('{"text": 1}'), '{"text": 1}');
  });
});

describe(devEventView, () => {
  it("lifts the reply, query and message out of the detail", () => {
    const event = sinkEvent(1, '{"text":"monitor down"}');
    assert.deepStrictEqual(devEventView(event), {
      at: 1001,
      detail: event.detail,
      id: 1,
      kind: "webhook",
      message: "monitor down",
      query: "?tag=t1",
      respondedWith: 200,
    });
  });

  it("tolerates a detail of another shape", () => {
    const view = devEventView({ at: 1, detail: [1, 2], id: 2, kind: "x" });
    assert.deepStrictEqual(
      [view.message, view.query, view.respondedWith],
      ["", null, null]
    );
  });
});

type RegistryStub = ReturnType<DevServiceDeps["registries"]["getByName"]>;

const makeService = (devMode: boolean, events: readonly DevEvent[]) => {
  const registry: Pick<RegistryStub, "devEvents"> = {
    devEvents: () => Effect.succeed(events),
  };
  return makeDevService({
    devMode,
    // SAFETY: the service only calls `getByName` on the namespace, then
    // `devEvents` on the stub; this double implements exactly those.
    registries: {
      getByName: (_name: string) => registry,
    } as DevServiceDeps["registries"],
  });
};

describe(makeDevService, () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    sinkEvent(index + 1, `alert ${index + 1}`)
  );

  it.effect("lists the latest events, newest first", () =>
    Effect.gen(function* eventsTest() {
      const listed = yield* makeService(true, events).events(3);
      assert.deepStrictEqual(
        listed.map((event) => [event.id, event.message]),
        [
          [5, "alert 5"],
          [4, "alert 4"],
          [3, "alert 3"],
        ]
      );
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );

  it.effect("is a 404 outside dev mode", () =>
    Effect.gen(function* gatedTest() {
      const error = yield* makeService(false, events)
        .events(3)
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "NotFound");
    }).pipe(Effect.provide(RuntimeContext.phantom))
  );
});
