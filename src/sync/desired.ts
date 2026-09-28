import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type {
  ChannelDefinition,
  KanshiConfig,
  MonitorDefinition,
} from "../config.ts";
import { checkChannelUrl, hashUrl } from "../domain/channel.ts";
import { parseExpectedStatus } from "../domain/expected-status.ts";
import { monitorDefaults } from "../domain/monitor-input.ts";
import { checkTargetUrl, describeUrlRejection } from "../domain/url.ts";
import type { Desired, DesiredChannel, DesiredMonitor } from "./plan.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

// Normalisation must match what the Worker stores, or every sync would
// see changes. The Worker's dev-only loopback allowance does not change the
// normalised form, so it is allowed here and left to the Worker to reject.
const normalizeTargetUrl = (url: string) =>
  checkTargetUrl(url, { allowLoopback: true }).pipe(
    Result.mapError((rejection) => `url: ${describeUrlRejection(rejection)}`)
  );
const normalizeChannelUrl = (url: string) =>
  checkChannelUrl(url, { devMode: true });

const channelUrl = (
  channel: ChannelDefinition,
  environment: Environment
): Result.Result<string, string> => {
  if (typeof channel.url === "string") {
    return normalizeChannelUrl(channel.url);
  }
  const value = environment[channel.url.env];
  return value === undefined || value.trim().length === 0
    ? Result.fail(`environment variable ${channel.url.env} is not set`)
    : normalizeChannelUrl(value.trim());
};

/** Defaults applied, URL and expected status normalised. */
const resolveMonitor = (
  monitor: MonitorDefinition
): Result.Result<DesiredMonitor, readonly string[]> => {
  const url = normalizeTargetUrl(monitor.url);
  const expectedStatus = parseExpectedStatus(
    monitor.expectedStatus ?? monitorDefaults.expectedStatus
  );
  if (Result.isFailure(url) || Result.isFailure(expectedStatus)) {
    return Result.fail([
      ...(Result.isFailure(url)
        ? [`monitor "${monitor.key}": ${url.failure}`]
        : []),
      ...(Result.isFailure(expectedStatus)
        ? [
            `monitor "${monitor.key}": expectedStatus: ${expectedStatus.failure}`,
          ]
        : []),
    ]);
  }
  const channelRefs = monitor.channels ?? monitorDefaults.channels;
  return Result.succeed({
    bodyContains: monitor.bodyContains ?? monitorDefaults.bodyContains,
    channels: channelRefs === "all" ? "all" : [...new Set(channelRefs)],
    enabled: monitor.enabled ?? monitorDefaults.enabled,
    expectedStatus: expectedStatus.success,
    failureThreshold:
      monitor.failureThreshold ?? monitorDefaults.failureThreshold,
    intervalSeconds: monitor.intervalSeconds ?? monitorDefaults.intervalSeconds,
    key: monitor.key,
    method: monitor.method ?? monitorDefaults.method,
    name: monitor.name,
    public: monitor.public ?? monitorDefaults.public,
    successThreshold:
      monitor.successThreshold ?? monitorDefaults.successThreshold,
    timeoutMs: monitor.timeoutMs ?? monitorDefaults.timeoutMs,
    url: url.success,
  });
};

/**
 * Resolve a decoded config into the desired state: env vars read, URLs
 * and expected statuses normalised, defaults applied, channel URLs hashed.
 * Every problem is reported, not only the first.
 */
export const resolveDesired = (
  config: KanshiConfig,
  environment: Environment
): Effect.Effect<{
  readonly desired: Desired;
  readonly errors: readonly string[];
}> =>
  Effect.gen(function* resolveDesiredEffect() {
    const errors: string[] = [];
    const channels: DesiredChannel[] = [];
    for (const channel of config.channels ?? []) {
      const url = channelUrl(channel, environment);
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
