import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/**
 * The Worker's settings, read from its config (bound at deploy time):
 * - `KANSHI_API_TOKEN` bearer token for `/api` and dashboard password
 *   (required, not empty)
 * - `KANSHI_DEV_MODE` set by the stack for the dev stage run locally
 * - `KANSHI_MONITOR_QUOTA` maximum number of monitors (default 100)
 */
export class KanshiSettings extends Context.Service<
  KanshiSettings,
  {
    readonly apiToken: Redacted.Redacted<string>;
    readonly devMode: boolean;
    readonly quota: number;
  }
>()("kanshi/KanshiSettings") {
  static readonly layer = Layer.effect(
    KanshiSettings,
    Effect.gen(function* KanshiSettingsLayer() {
      const apiToken = yield* Config.Redacted("KANSHI_API_TOKEN");
      if (Redacted.value(apiToken).trim().length === 0) {
        return yield* Effect.die(
          new Error("KANSHI_API_TOKEN must not be empty")
        );
      }
      const devMode = yield* Config.Boolean("KANSHI_DEV_MODE").pipe(
        Config.withDefault(false)
      );
      const quota = yield* Config.Int("KANSHI_MONITOR_QUOTA").pipe(
        Config.withDefault(100)
      );
      return KanshiSettings.of({ apiToken, devMode, quota });
    })
  );
}
