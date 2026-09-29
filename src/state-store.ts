// The stack's Alchemy state store, chosen by stage (`stateStoreFor` in
// `stages.ts`). Its own module so `test/unit/state-store.test.ts` can
// build the real layer without importing the stack's side effects.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { stateStoreFor } from "./stages.ts";

/** The state layer for each {@link stateStoreFor} answer. */
export const stateLayers = {
  cloudflare: Cloudflare.state(),
  local: Alchemy.localState(),
};

/**
 * A state layer that picks one of `layers` by `Alchemy.Stage` once the
 * CLI has resolved it (`Stage` is among the services the Stack builds its
 * `state` layer with). Only the chosen layer is built, so local stages
 * never contact Cloudflare. Fails (a defect) without a `Stage`.
 */
export const selectState = <E1, R1, E2, R2>(layers: {
  readonly cloudflare: Layer.Layer<State, E1, R1>;
  readonly local: Layer.Layer<State, E2, R2>;
}) =>
  Layer.unwrap(
    Alchemy.Stage.pipe(
      Effect.map((stage): Layer.Layer<State, E1 | E2, R1 | R2> =>
        stateStoreFor(stage) === "cloudflare" ? layers.cloudflare : layers.local
      )
    )
  );

/** The `state` of the Kanshi stack (`alchemy.run.ts`). */
export const state = selectState(stateLayers);
