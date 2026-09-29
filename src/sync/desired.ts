import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import type {
  ChannelDefinition,
  KanshiConfig,
  MonitorDefinition,
} from "../config.ts";
import { checkChannelUrl, hashUrl } from "../domain/channel.ts";
import { parseExpectedStatus } from "../domain/expected-status.ts";
import { checkMethodBody, monitorDefaults } from "../domain/monitor-input.ts";
import { checkTargetUrl, describeUrlRejection } from "../domain/url.ts";
import type { Desired, DesiredChannel, DesiredMonitor } from "./plan.ts";

// Normalisation must match what the Worker stores, or every sync would
// see changes. The Worker's dev-only loopback allowance does not change the
// normalised form, so it is allowed here and left to the Worker to reject.
const normalizeTargetUrl = (url: string) =>
  checkTargetUrl(url, { allowLoopback: true }).pipe(
    Result.mapError((rejection) => `url: ${describeUrlRejection(rejection)}`)
  );
const normalizeChannelUrl = (url: string) =>
  checkChannelUrl(url, { devMode: true });

/**
 * The value of `env("NAME")`, read with `Config` from the current
 * `ConfigProvider` (the environment by default). Blank counts as not set.
 */
const readEnv = (name: string): Effect.Effect<Result.Result<string, string>> =>
  Config.option(Config.String(name)).pipe(
    Effect.map((value) =>
      value.pipe(
        Option.map((text) => text.trim()),
        Option.filter((text) => text.length > 0),
        Option.match({
          onNone: () => Result.fail(`environment variable ${name} is not set`),
          onSome: Result.succeed,
        })
      )
    ),
    Effect.catchTag("ConfigError", (cause) =>
      Effect.succeed(
        Result.fail(
          `cannot read environment variable ${name}: ${cause.message}`
        )
      )
    )
  );

const channelUrl = (
  channel: ChannelDefinition
): Effect.Effect<Result.Result<string, string>> =>
  Predicate.isString(channel.url)
    ? Effect.succeed(normalizeChannelUrl(channel.url))
    : readEnv(channel.url.env).pipe(
        Effect.map(Result.flatMap(normalizeChannelUrl))
      );

/** Defaults applied, URL and expected status normalised. */
const resolveMonitor = (
  monitor: MonitorDefinition
): Result.Result<DesiredMonitor, readonly string[]> => {
  const url = normalizeTargetUrl(monitor.url);
  const expectedStatus = parseExpectedStatus(
    monitor.expectedStatus ?? monitorDefaults.expectedStatus
  );
  const method = monitor.method ?? monitorDefaults.method;
  const bodyContains = monitor.bodyContains ?? monitorDefaults.bodyContains;
  const methodBody = checkMethodBody(method, bodyContains);
  if (
    Result.isFailure(url) ||
    Result.isFailure(expectedStatus) ||
    Result.isFailure(methodBody)
  ) {
    return Result.fail([
      ...(Result.isFailure(url)
        ? [`monitor "${monitor.key}": ${url.failure}`]
        : []),
      ...(Result.isFailure(expectedStatus)
        ? [
            `monitor "${monitor.key}": expectedStatus: ${expectedStatus.failure}`,
          ]
        : []),
      ...(Result.isFailure(methodBody)
        ? [`monitor "${monitor.key}": ${methodBody.failure}`]
        : []),
    ]);
  }
  const channelRefs = monitor.channels ?? monitorDefaults.channels;
  return Result.succeed({
    bodyContains,
    channels: channelRefs === "all" ? "all" : [...new Set(channelRefs)],
    enabled: monitor.enabled ?? monitorDefaults.enabled,
    expectedStatus: expectedStatus.success,
    failureThreshold:
      monitor.failureThreshold ?? monitorDefaults.failureThreshold,
    intervalSeconds: monitor.intervalSeconds ?? monitorDefaults.intervalSeconds,
    key: monitor.key,
    method,
    name: monitor.name,
    public: monitor.public ?? monitorDefaults.public,
    successThreshold:
      monitor.successThreshold ?? monitorDefaults.successThreshold,
    timeoutMs: monitor.timeoutMs ?? monitorDefaults.timeoutMs,
    url: url.success,
  });
};

/**
 * Resolve a decoded config into the desired state: `env("NAME")` read
 * with `Config` from the current `ConfigProvider`, URLs
 * and expected statuses normalised, defaults applied, channel URLs hashed.
 * Every problem is reported, not only the first.
 */
export const resolveDesired = (
  config: KanshiConfig
): Effect.Effect<{
  readonly desired: Desired;
  readonly errors: readonly string[];
}> =>
  Effect.gen(function* resolveDesiredEffect() {
    const errors: string[] = [];
    const channels: DesiredChannel[] = [];
    for (const channel of config.channels ?? []) {
      const url = yield* channelUrl(channel);
      if (Result.isFailure(url)) {
        errors.push(`channel "${channel.key}": ${url.failure}`);
        continue;
      }
      channels.push({
        key: channel.key,
        kind: channel.kind,
        name: channel.name,
        url: url.success,
        urlHash: yield* hashUrl(url.success),
      });
    }

    const monitors: DesiredMonitor[] = [];
    for (const monitor of config.monitors ?? []) {
      const resolved = resolveMonitor(monitor);
      if (Result.isFailure(resolved)) {
        errors.push(...resolved.failure);
      } else {
        monitors.push(resolved.success);
      }
    }
    return { desired: { channels, monitors }, errors };
  });
