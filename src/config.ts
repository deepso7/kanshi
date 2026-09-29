import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { ChannelKind } from "./domain/channel.ts";
import { MonitorCreateInput, MonitorKey } from "./domain/monitor-input.ts";

/** A value read from an environment variable when `kanshi sync` runs. */
export const EnvRef = Schema.Struct({ env: Schema.NonEmptyString });
export type EnvRef = typeof EnvRef.Type;

/**
 * Read a secret (a channel URL) from the environment at sync time, so it
 * never has to be written in the config file: `url: env("SLACK_URL")`.
 */
export const env = (name: string): EnvRef => ({ env: name });

/**
 * An alert channel in a config file. `key` identifies it across runs; the
 * URL is a literal string or `env("NAME")`.
 */
export const ChannelDefinition = Schema.Struct({
  key: MonitorKey,
  kind: ChannelKind,
  name: Schema.NonEmptyString,
  url: Schema.Union([Schema.NonEmptyString, EnvRef]),
});
export type ChannelDefinition = typeof ChannelDefinition.Type;

/**
 * A monitor in a config file. `key` identifies it across runs. Fields
 * left out take the API defaults (so removing one resets it). `channels`
 * is `"all"` or a list of channel **keys** (channels in this file, or
 * channels created in the dashboard).
 */
export const MonitorDefinition = MonitorCreateInput.mapFields(
  Struct.omit(["channels", "key", "managed"])
).mapFields(
  Struct.assign({
    channels: Schema.optionalKey(
      Schema.Union([Schema.Literal("all"), Schema.Array(MonitorKey)])
    ),
    key: MonitorKey,
  })
);
export type MonitorDefinition = typeof MonitorDefinition.Type;

export const KanshiConfig = Schema.Struct({
  channels: Schema.optionalKey(Schema.Array(ChannelDefinition)),
  monitors: Schema.optionalKey(Schema.Array(MonitorDefinition)),
});
export type KanshiConfig = typeof KanshiConfig.Type;

/**
 * Typed helper for `kanshi.config.ts` (applied with `pnpm kanshi sync`)
 * and `kanshi.dev.config.ts` (applied to the dev stack by `pnpm seed`).
 */
export const defineConfig = (config: KanshiConfig): KanshiConfig => config;
