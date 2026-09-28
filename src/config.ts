import type { MonitorCreateInput } from "./domain/monitor-input.ts";

/** A monitor in a config file; `key` identifies it across runs. */
export type MonitorDefinition = MonitorCreateInput & { readonly key: string };

export interface KanshiConfig {
  readonly monitors: readonly MonitorDefinition[];
}

/**
 * Typed helper for `kanshi.dev.config.ts` (and, in phase 7,
 * `kanshi.config.ts`).
 */
export const defineConfig = (config: KanshiConfig): KanshiConfig => config;
