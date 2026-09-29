import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { afterAll, vi } from "vitest";

import { selectState, state } from "../../src/state-store.ts";

// `Alchemy.localState()` anchors `.alchemy/` at the cwd when alchemy is
// loaded, so move to a temp dir before the imports above run: the local
// store then writes there, never to the repo's `.alchemy/`.
const { tmp, repoCwd } = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { default: nodePath } = await import("node:path");
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "kanshi-state-"));
  process.chdir(dir);
  return { repoCwd: cwd, tmp: fs.realpathSync(dir) };
});

const withStage = (stage: string) => Layer.succeed(Alchemy.Stage, stage);

/**
 * Runs `effect` with only the services it is given, not the ones its type
 * still lists.
 */
const withoutServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E> =>
  // SAFETY: deliberately unprovided; a missing service is a defect ("Service
  // not found"), which the tests either expect or would report as a failure.
  effect as Effect.Effect<A, E>;

describe("state (the stack's state layer)", () => {
  afterAll(() => {
    process.chdir(repoCwd);
    rmSync(tmp, { force: true, recursive: true });
  });

  // Given only `Stage` and the platform, not the Cloudflare store's
  // services (credentials, HTTP, prompts): the local branch needs none.
  for (const stage of ["dev", "integ-alerts"]) {
    it.effect(`builds a local store in .alchemy/ for ${stage}`, () =>
      Effect.gen(function* localStore() {
        const store = yield* yield* State;
        assert.strictEqual(store.id, "local");

        const stack = "StateStoreTest";
        assert.deepStrictEqual(yield* store.list({ stack, stage }), []);
        yield* store.setOutput({ stack, stage, value: { url: "x" } });
        assert.deepStrictEqual(yield* store.getOutput({ stack, stage }), {
          url: "x",
        });
        assert.isTrue(
          existsSync(path.join(tmp, ".alchemy", "state", stack, stage)),
          "written under the temp dir"
        );
      }).pipe(
        Effect.provide(
          state.pipe(
            Layer.provide(Layer.merge(withStage(stage), NodeServices.layer))
          )
        ),
        withoutServices
      )
    );
  }
});

// Sentinels for the two stores, recording which one gets built; the
// real Cloudflare layer would bootstrap a state store in the account.
const makeLayers = () => {
  const built: string[] = [];
  const sentinel = (name: string) => {
    const service = Effect.die(`${name} store used`);
    return {
      layer: Layer.effect(
        State,
        Effect.sync(() => {
          built.push(name);
          return service;
        })
      ),
      service,
    };
  };
  const cloudflare = sentinel("cloudflare");
  const local = sentinel("local");
  return {
    built,
    cloudflare,
    layer: selectState({ cloudflare: cloudflare.layer, local: local.layer }),
    local,
  };
};

describe(selectState, () => {
  it.effect("picks the Cloudflare store for prod, building only it", () => {
    const { built, cloudflare, layer } = makeLayers();
    return Effect.gen(function* prodStore() {
      assert.strictEqual(yield* State, cloudflare.service);
      assert.deepStrictEqual(built, ["cloudflare"]);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(withStage("prod")))));
  });

  it.effect("picks the local store for dev and integ-*, building only it", () =>
    Effect.gen(function* localStores() {
      for (const stage of ["dev", "integ", "integ-ui"]) {
        const { built, layer, local } = makeLayers();
        const service = yield* State.pipe(
          Effect.provide(layer.pipe(Layer.provide(withStage(stage))))
        );
        assert.strictEqual(service, local.service, stage);
        assert.deepStrictEqual(built, ["local"], stage);
      }
    })
  );

  it.effect("fails without a Stage, building neither store", () => {
    const { built, layer } = makeLayers();
    return Effect.gen(function* noStage() {
      const exit = yield* Layer.build(layer).pipe(
        Effect.scoped,
        withoutServices,
        Effect.exit
      );
      assert.isTrue(Exit.hasDies(exit));
      assert.deepStrictEqual(built, []);
    });
  });
});
