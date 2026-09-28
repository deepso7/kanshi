import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  defaultExpectedStatus,
  parseExpectedStatus,
} from "./expected-status.ts";
import { ChannelSelection, MonitorMethod } from "./monitor.ts";
import type { MonitorConfig } from "./monitor.ts";
import { checkTargetUrl, describeUrlRejection } from "./url.ts";

export const productionMinIntervalSeconds = 30;
export const devMinIntervalSeconds = 5;
export const maxIntervalSeconds = 24 * 60 * 60;

const Threshold = Schema.Int.check(
  Schema.isBetween({ maximum: 10, minimum: 1 })
);
const TimeoutMs = Schema.Int.check(
  Schema.isBetween({ maximum: 30_000, minimum: 1000 })
);
const IntervalSeconds = Schema.Int.check(
  Schema.isBetween({ maximum: maxIntervalSeconds, minimum: 1 })
);
export const MonitorKey = Schema.String.check(
  Schema.isPattern(/^[\da-z][\d._a-z-]{0,63}$/iu)
);
const ExpectedStatusInput = Schema.Union([Schema.Int, Schema.String]);
const BodyContains = Schema.NullOr(
  Schema.String.check(Schema.isMaxLength(1024))
);

const editableFields = {
  bodyContains: Schema.optionalKey(BodyContains),
  channels: Schema.optionalKey(ChannelSelection),
  enabled: Schema.optionalKey(Schema.Boolean),
  expectedStatus: Schema.optionalKey(ExpectedStatusInput),
  failureThreshold: Schema.optionalKey(Threshold),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  managed: Schema.optionalKey(Schema.Boolean),
  method: Schema.optionalKey(MonitorMethod),
  public: Schema.optionalKey(Schema.Boolean),
  successThreshold: Schema.optionalKey(Threshold),
  timeoutMs: Schema.optionalKey(TimeoutMs),
};

export const MonitorCreateInput = Schema.Struct({
  ...editableFields,
  key: Schema.optionalKey(MonitorKey),
  name: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
});
export type MonitorCreateInput = typeof MonitorCreateInput.Type;

export const MonitorPatchInput = Schema.Struct({
  ...editableFields,
  name: Schema.optionalKey(Schema.NonEmptyString),
  url: Schema.optionalKey(Schema.NonEmptyString),
});
export type MonitorPatchInput = typeof MonitorPatchInput.Type;

/**
 * What an omitted field means on create. Config sync applies the same
 * defaults, so removing a field from `kanshi.config.ts` resets it.
 */
export const monitorDefaults = {
  bodyContains: null,
  channels: "all",
  enabled: true,
  expectedStatus: defaultExpectedStatus,
  failureThreshold: 1,
  intervalSeconds: 60,
  method: "GET",
  public: false,
  successThreshold: 1,
  timeoutMs: 10_000,
} as const;

/** `all`, or the listed channel ids without duplicates. */
const normalizeChannels = (channels: ChannelSelection): ChannelSelection =>
  channels === "all" ? channels : [...new Set(channels)];

export interface InputOptions {
  /** Dev stage: loopback targets and intervals down to 5s are allowed. */
  readonly devMode: boolean;
  readonly now: number;
}

export const minIntervalSeconds = (devMode: boolean): number =>
  devMode ? devMinIntervalSeconds : productionMinIntervalSeconds;

const checkUrl = (url: string, devMode: boolean) =>
  checkTargetUrl(url, { allowLoopback: devMode }).pipe(
    Result.mapError((rejection) => `url: ${describeUrlRejection(rejection)}`)
  );

const checkInterval = (
  intervalSeconds: number,
  devMode: boolean
): Result.Result<number, string> => {
  const min = minIntervalSeconds(devMode);
  return intervalSeconds < min
    ? Result.fail(`intervalSeconds must be at least ${min}`)
    : Result.succeed(intervalSeconds);
};

const checkExpectedStatus = (input: number | string) =>
  parseExpectedStatus(input).pipe(
    Result.mapError((message) => `expectedStatus: ${message}`)
  );

/** Build a new monitor's configuration (generation 0) from API input. */
export const buildConfig = (
  id: string,
  input: MonitorCreateInput,
  options: InputOptions
): Result.Result<MonitorConfig, string> =>
  Result.gen(function* buildConfigResult() {
    const url = yield* checkUrl(input.url, options.devMode);
    const intervalSeconds = yield* checkInterval(
      input.intervalSeconds ?? monitorDefaults.intervalSeconds,
      options.devMode
    );
    const expectedStatus = yield* checkExpectedStatus(
      input.expectedStatus ?? monitorDefaults.expectedStatus
    );
    return {
      bodyContains: input.bodyContains ?? monitorDefaults.bodyContains,
      channels: normalizeChannels(input.channels ?? monitorDefaults.channels),
      createdAt: options.now,
      enabled: input.enabled ?? monitorDefaults.enabled,
      expectedStatus,
      failureThreshold:
        input.failureThreshold ?? monitorDefaults.failureThreshold,
      generation: 0,
      id,
      intervalSeconds,
      key: input.key ?? id,
      managed: input.managed ?? false,
      method: input.method ?? monitorDefaults.method,
      name: input.name,
      successThreshold:
        input.successThreshold ?? monitorDefaults.successThreshold,
      timeoutMs: input.timeoutMs ?? monitorDefaults.timeoutMs,
      updatedAt: options.now,
      url,
    } satisfies MonitorConfig;
  });

/** Config fields whose change invalidates in-flight probes and streaks. */
export const probeAffectingFields = [
  "bodyContains",
  "expectedStatus",
  "failureThreshold",
  "intervalSeconds",
  "method",
  "successThreshold",
  "timeoutMs",
  "url",
] as const satisfies readonly (keyof MonitorConfig)[];

/**
 * Apply a validated patch to a configuration. Does not touch `generation`;
 * the reset rules in `src/monitor/reset.ts` decide that.
 */
export const patchConfig = (
  config: MonitorConfig,
  patch: MonitorPatchInput,
  options: InputOptions
): Result.Result<MonitorConfig, string> =>
  Result.gen(function* patchConfigResult() {
    const url =
      patch.url === undefined
        ? config.url
        : yield* checkUrl(patch.url, options.devMode);
    const intervalSeconds =
      patch.intervalSeconds === undefined
        ? config.intervalSeconds
        : yield* checkInterval(patch.intervalSeconds, options.devMode);
    const expectedStatus =
      patch.expectedStatus === undefined
        ? config.expectedStatus
        : yield* checkExpectedStatus(patch.expectedStatus);
    return {
      ...config,
      bodyContains:
        patch.bodyContains === undefined
          ? config.bodyContains
          : patch.bodyContains,
      channels:
        patch.channels === undefined
          ? config.channels
          : normalizeChannels(patch.channels),
      enabled: patch.enabled ?? config.enabled,
      expectedStatus,
      failureThreshold: patch.failureThreshold ?? config.failureThreshold,
      intervalSeconds,
      managed: patch.managed ?? config.managed,
      method: patch.method ?? config.method,
      name: patch.name ?? config.name,
      successThreshold: patch.successThreshold ?? config.successThreshold,
      timeoutMs: patch.timeoutMs ?? config.timeoutMs,
      updatedAt: options.now,
      url,
    } satisfies MonitorConfig;
  });
