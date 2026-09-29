// Config sync (`kanshi sync`): the pure diff between the desired config
// and what the API reports, and the plan's text. Only `managed` resources
// are touched; a key that belongs to a resource created in the dashboard
// is an error unless `adopt` is set.
import * as Data from "effect/Data";

import type { ChannelKind, ChannelView } from "../domain/channel.ts";
import type { MonitorMethod } from "../domain/monitor.ts";

/** `all`, or channel keys (config) / ids (API). */
export type ChannelRefs = "all" | readonly string[];

/** A config channel, its URL resolved, normalised and hashed. */
export interface DesiredChannel {
  readonly key: string;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly url: string;
  readonly urlHash: string;
}

/** The monitor fields sync owns, with the API defaults applied. */
export interface MonitorSettings {
  readonly bodyContains: string | null;
  readonly enabled: boolean;
  readonly expectedStatus: string;
  readonly failureThreshold: number;
  readonly intervalSeconds: number;
  readonly method: MonitorMethod;
  readonly name: string;
  readonly public: boolean;
  readonly successThreshold: number;
  readonly timeoutMs: number;
  readonly url: string;
}

export const monitorSettingKeys = [
  "name",
  "url",
  "method",
  "expectedStatus",
  "bodyContains",
  "timeoutMs",
  "intervalSeconds",
  "failureThreshold",
  "successThreshold",
  "enabled",
  "public",
] as const satisfies readonly (keyof MonitorSettings)[];

/** A config monitor: normalised settings, channels by **key**. */
export interface DesiredMonitor extends MonitorSettings {
  readonly channels: ChannelRefs;
  readonly key: string;
}

export interface Desired {
  readonly channels: readonly DesiredChannel[];
  readonly monitors: readonly DesiredMonitor[];
}

/**
 * A monitor as the API reports it. `settings` are only needed for managed
 * monitors and adoption candidates; `channels` (by **id**) for those, and
 * for every other monitor when the sync deletes a channel (to refuse
 * deleting a channel a surviving monitor still lists).
 */
export interface CurrentMonitor {
  readonly channels?: ChannelRefs;
  readonly id: string;
  readonly key: string;
  readonly managed: boolean;
  readonly name: string;
  readonly settings?: MonitorSettings;
}

export interface Current {
  readonly channels: readonly ChannelView[];
  readonly monitors: readonly CurrentMonitor[];
}

export interface ChannelPatch {
  readonly kind?: ChannelKind;
  readonly managed?: true;
  readonly name?: string;
  readonly url?: string;
}

export type MonitorPatch = Partial<MonitorSettings> & {
  readonly channels?: ChannelRefs;
  readonly managed?: true;
};

/** One API call. Monitor `channels` are keys until applied. */
export type Step = Data.TaggedEnum<{
  CreateChannel: { readonly channel: DesiredChannel };
  UpdateChannel: {
    readonly changes: readonly string[];
    readonly id: string;
    readonly key: string;
    readonly patch: ChannelPatch;
  };
  CreateMonitor: { readonly monitor: DesiredMonitor };
  UpdateMonitor: {
    readonly changes: readonly string[];
    readonly id: string;
    readonly key: string;
    readonly patch: MonitorPatch;
  };
  DeleteMonitor: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
  };
  DeleteChannel: {
    readonly id: string;
    readonly key: string;
    readonly name: string;
  };
}>;
export const Step = Data.taggedEnum<Step>();

/**
 * `steps` in the order they must run: channels are created and updated
 * before the monitors that reference them, monitors are deleted before
 * channels. A plan with `errors` must not be applied.
 */
export interface Plan {
  readonly errors: readonly string[];
  readonly steps: readonly Step[];
}

export interface DiffOptions {
  /** Take over unmanaged resources whose key is in the config. */
  readonly adopt: boolean;
}

const duplicates = (keys: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      repeated.add(key);
    }
    seen.add(key);
  }
  return [...repeated];
};

const sameRefs = (a: ChannelRefs, b: ChannelRefs): boolean => {
  if (a === "all" || b === "all") {
    return a === b;
  }
  const left = [...new Set(a)].toSorted();
  const right = [...new Set(b)].toSorted();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
};

const byKey = <A extends { readonly key: string }>(items: readonly A[]) =>
  new Map(items.map((item) => [item.key, item] as const));

const diffChannels = (
  desired: Desired,
  current: Current,
  options: DiffOptions,
  errors: string[]
) => {
  const existing = byKey(current.channels);
  const wanted = new Set(desired.channels.map((channel) => channel.key));
  const upserts: Step[] = [];
  for (const channel of desired.channels) {
    const found = existing.get(channel.key);
    if (found === undefined) {
      upserts.push(Step.CreateChannel({ channel }));
      continue;
    }
    if (!found.managed && !options.adopt) {
      errors.push(
        `channel "${channel.key}" exists but was not created by config sync (managed: false); rename the key, delete that channel, or re-run with --adopt`
      );
      continue;
    }
    const changes: string[] = [];
    const patch: {
      -readonly [K in keyof ChannelPatch]: ChannelPatch[K];
    } = {};
    if (!found.managed) {
      changes.push("managed");
      patch.managed = true;
    }
    if (found.kind !== channel.kind) {
      changes.push("kind");
      patch.kind = channel.kind;
    }
    if (found.name !== channel.name) {
      changes.push("name");
      patch.name = channel.name;
    }
    if (found.urlHash !== channel.urlHash) {
      changes.push("url");
      patch.url = channel.url;
    }
    if (changes.length > 0) {
      upserts.push(
        Step.UpdateChannel({ changes, id: found.id, key: channel.key, patch })
      );
    }
  }
  const deletes: Step[] = current.channels
    .filter((channel) => channel.managed && !wanted.has(channel.key))
    .map((channel) =>
      Step.DeleteChannel({
        id: channel.id,
        key: channel.key,
        name: channel.name,
      })
    );
  return { deletes, upserts };
};

const diffMonitors = (
  desired: Desired,
  current: Current,
  options: DiffOptions,
  errors: string[]
) => {
  // Channel keys a monitor may use: the config's, plus dashboard-created
  // channels that stay. Managed channels missing from the config are
  // about to be deleted, so they do not count.
  const configKeys = new Set(desired.channels.map((channel) => channel.key));
  const usable = new Set([
    ...configKeys,
    ...current.channels
      .filter((channel) => !channel.managed)
      .map((channel) => channel.key),
  ]);
  const keyOfChannel = new Map(
    current.channels.map((channel) => [channel.id, channel.key] as const)
  );
  /** Current ids as keys; a dangling id never equals a key. */
  const asKeys = (refs: ChannelRefs): ChannelRefs =>
    refs === "all"
      ? refs
      : refs.map((id) => keyOfChannel.get(id) ?? `#deleted:${id}`);

  const existing = byKey(current.monitors);
  const wanted = new Set(desired.monitors.map((monitor) => monitor.key));
  const upserts: Step[] = [];
  for (const monitor of desired.monitors) {
    if (monitor.channels !== "all") {
      const unknown = monitor.channels.filter((key) => !usable.has(key));
      if (unknown.length > 0) {
        errors.push(
          `monitor "${monitor.key}": unknown channel key(s) ${unknown.map((key) => `"${key}"`).join(", ")}`
        );
      }
    }
    const found = existing.get(monitor.key);
    if (found === undefined) {
      upserts.push(Step.CreateMonitor({ monitor }));
      continue;
    }
    if (!found.managed && !options.adopt) {
      errors.push(
        `monitor "${monitor.key}" exists but was not created by config sync (managed: false); rename the key, delete that monitor, or re-run with --adopt`
      );
      continue;
    }
    const changes: string[] = [];
    const patch: {
      -readonly [K in keyof MonitorPatch]: MonitorPatch[K];
    } = {};
    if (!found.managed) {
      changes.push("managed");
      patch.managed = true;
    }
    const copyField = <K extends keyof MonitorSettings>(field: K) => {
      patch[field] = monitor[field];
    };
    for (const field of monitorSettingKeys) {
      if (found.settings?.[field] !== monitor[field]) {
        changes.push(field);
        copyField(field);
      }
    }
    if (!sameRefs(asKeys(found.channels ?? []), monitor.channels)) {
      changes.push("channels");
      patch.channels = monitor.channels;
    }
    if (changes.length > 0) {
      upserts.push(
        Step.UpdateMonitor({ changes, id: found.id, key: monitor.key, patch })
      );
    }
  }
  const deletes: Step[] = current.monitors
    .filter((monitor) => monitor.managed && !wanted.has(monitor.key))
    .map((monitor) =>
      Step.DeleteMonitor({
        id: monitor.id,
        key: monitor.key,
        name: monitor.name,
      })
    );
  return { deletes, upserts };
};

/**
 * A managed channel dropped from the config must not be deleted while a
 * monitor that survives the sync (one outside the config, e.g. created in
 * the dashboard) still lists it. Monitors in the config are checked against
 * the usable channel keys instead; managed monitors missing from the
 * config are deleted first.
 */
const checkChannelDeletes = (
  desired: Desired,
  current: Current,
  channelDeletes: readonly Step[],
  errors: string[]
) => {
  const wanted = new Set(desired.monitors.map((monitor) => monitor.key));
  const survivors = current.monitors.filter(
    (monitor) => !monitor.managed && !wanted.has(monitor.key)
  );
  for (const step of channelDeletes) {
    if (!Step.$is("DeleteChannel")(step)) {
      continue;
    }
    const users = survivors.filter(
      (monitor) =>
        monitor.channels !== undefined &&
        monitor.channels !== "all" &&
        monitor.channels.includes(step.id)
    );
    if (users.length > 0) {
      errors.push(
        `channel "${step.key}" is not in the config but is still used by monitor(s) ${users.map((monitor) => `"${monitor.key}"`).join(", ")} (not managed by config sync); remove it from those monitors or keep the channel in the config`
      );
    }
  }
};

/**
 * Diff the desired config against the API's current resources. Pure: the
 * caller resolves env vars, normalises URLs and hashes channel URLs first.
 */
export const diff = (
  desired: Desired,
  current: Current,
  options?: DiffOptions
): Plan => {
  const opts = options ?? { adopt: false };
  const errors: string[] = [];
  for (const key of duplicates(desired.channels.map((c) => c.key))) {
    errors.push(`channel key "${key}" is used more than once in the config`);
  }
  for (const key of duplicates(desired.monitors.map((m) => m.key))) {
    errors.push(`monitor key "${key}" is used more than once in the config`);
  }
  const channels = diffChannels(desired, current, opts, errors);
  const monitors = diffMonitors(desired, current, opts, errors);
  checkChannelDeletes(desired, current, channels.deletes, errors);
  return {
    errors,
    steps: [
      ...channels.upserts,
      ...monitors.upserts,
      ...monitors.deletes,
      ...channels.deletes,
    ],
  };
};

export const describeStep = (step: Step): string =>
  Step.$match(step, {
    CreateChannel: ({ channel }) =>
      `+ channel ${channel.key} (${channel.kind})`,
    CreateMonitor: ({ monitor }) => `+ monitor ${monitor.key} (${monitor.url})`,
    DeleteChannel: ({ key, name }) => `- channel ${key} (${name})`,
    DeleteMonitor: ({ key, name }) => `- monitor ${key} (${name})`,
    UpdateChannel: ({ changes, key }) =>
      `~ channel ${key}: ${changes.join(", ")}`,
    UpdateMonitor: ({ changes, key }) =>
      `~ monitor ${key}: ${changes.join(", ")}`,
  });

/** The plan as printed by `kanshi sync`. */
export const formatPlan = (plan: Plan): string => {
  if (plan.errors.length > 0) {
    return [
      "Config errors (nothing was changed):",
      ...plan.errors.map((error) => `  ! ${error}`),
    ].join("\n");
  }
  if (plan.steps.length === 0) {
    return "No changes.";
  }
  const count = (prefix: string) =>
    plan.steps.filter((step) => step._tag.startsWith(prefix)).length;
  return [
    ...plan.steps.map((step) => `  ${describeStep(step)}`),
    `${count("Create")} to create, ${count("Update")} to update, ${count("Delete")} to delete.`,
  ].join("\n");
};
