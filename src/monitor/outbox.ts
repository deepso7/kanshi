import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { DeliveryResult } from "../alerts/delivery.ts";
import { backoffMs, maxAttempts } from "../alerts/delivery.ts";
import type { AlertEvent, Notification, OutboxEntry } from "../domain/alert.ts";
import type { IncidentResolution } from "../domain/monitor.ts";

/**
 * Pure alert rules for the Monitor DO: when notifications resolve, in which
 * order outbox rows are sent or skipped, how failures back off, and which
 * due times feed the alarm.
 */

/** The incident fields that decide how a `down` alert reads. */
export interface IncidentStatus {
  readonly resolution: IncidentResolution | null;
  readonly resolvedAt: number | null;
}

/** `down` sorts before `up`. */
const eventRank = (event: AlertEvent): number => (event === "down" ? 0 : 1);

const sameIncident = (left: Notification, right: Notification): boolean =>
  left.incidentId === right.incidentId;

/**
 * An `up` notification waits until its incident's `down` notification is
 * resolved, so it fans out to the recipients `down` fixed.
 */
export const notificationWaits = (
  notification: Notification,
  all: readonly Notification[]
): boolean =>
  notification.event === "up" &&
  all.some(
    (other) =>
      other.event === "down" &&
      !other.resolved &&
      sameIncident(other, notification)
  );

/**
 * Unresolved notifications that can be worked on at `now`, `down` before
 * `up` so an `up` can resolve in the same pass as its `down`.
 */
export const dueNotifications = (
  all: readonly Notification[],
  now: number
): readonly Notification[] =>
  all
    .filter((notification) => !notification.resolved)
    .filter((notification) => notification.nextAttemptAt <= now)
    .toSorted(
      (left, right) =>
        left.createdAt - right.createdAt ||
        eventRank(left.event) - eventRank(right.event)
    );

/** The earliest retry of an unresolved notification that is not waiting. */
export const notificationsDueAt = (
  all: readonly Notification[]
): number | null => {
  const times = all
    .filter(
      (notification) =>
        !notification.resolved && !notificationWaits(notification, all)
    )
    .map((notification) => notification.nextAttemptAt);
  return times.length === 0 ? null : Math.min(...times);
};

/** Resolving failed (Registry unreachable): retry with backoff, forever. */
export const notificationFailed = (
  notification: Notification,
  error: string,
  now: number
): Notification => {
  const attempts = notification.attempts + 1;
  return {
    ...notification,
    attempts,
    lastError: error,
    nextAttemptAt: now + backoffMs(attempts),
  };
};

export type OutboxDecision =
  /** Nothing to do: the row is no longer pending. */
  | { readonly _tag: "Done" }
  /** An `up` whose `down` is still pending. */
  | { readonly _tag: "Wait" }
  | { readonly _tag: "Skip"; readonly reason: string }
  | {
      readonly _tag: "Send";
      readonly message: "Down" | "DownRecovered" | "Recovered";
    };

/**
 * What to do with an outbox row, per channel:
 *
 * - `down`: skipped if its incident is gone or was closed by disabling or
 *   deleting the monitor; sent as "was down for Xm, recovered" if the
 *   incident already recovered; otherwise sent as down.
 * - `up`: waits while the `down` row for the same incident and channel is
 *   pending; skipped if that row failed or was skipped (the channel never
 *   heard of the outage) or already said the incident recovered; otherwise
 *   sent.
 */
export const outboxDecision = (
  entry: OutboxEntry,
  down: OutboxEntry | null,
  incident: IncidentStatus | null
): OutboxDecision => {
  if (entry.state !== "pending") {
    return { _tag: "Done" };
  }
  if (entry.event === "down") {
    if (incident === null) {
      return { _tag: "Skip", reason: "incident no longer exists" };
    }
    if (
      incident.resolution === "disabled" ||
      incident.resolution === "deleted"
    ) {
      return {
        _tag: "Skip",
        reason: `incident closed (${incident.resolution}) before the alert was sent`,
      };
    }
    return {
      _tag: "Send",
      message: incident.resolvedAt === null ? "Down" : "DownRecovered",
    };
  }
  if (down === null) {
    return { _tag: "Skip", reason: "no down alert for this channel" };
  }
  switch (down.state) {
    case "pending": {
      return { _tag: "Wait" };
    }
    case "failed":
    case "skipped": {
      return { _tag: "Skip", reason: `down alert ${down.state}` };
    }
    case "delivered": {
      return down.combined
        ? { _tag: "Skip", reason: "the down alert already reported recovery" }
        : { _tag: "Send", message: "Recovered" };
    }
    default: {
      return down.state satisfies never;
    }
  }
};

const key = (entry: OutboxEntry): string =>
  `${entry.incidentId}\u0000${entry.channelId}`;

/** The `down` row for each (incident, channel) among `entries`. */
export const downRows = (
  entries: readonly OutboxEntry[]
): ReadonlyMap<string, OutboxEntry> =>
  new Map(
    entries
      .filter((entry) => entry.event === "down")
      .map((entry) => [key(entry), entry])
  );

/** The `down` row matching `entry` (same incident and channel), if any. */
export const downRowOf = (
  entry: OutboxEntry,
  downs: ReadonlyMap<string, OutboxEntry>
): OutboxEntry | null => downs.get(key(entry)) ?? null;

/** Pending rows that are due at `now`, oldest first, `down` before `up`. */
export const dueOutbox = (
  entries: readonly OutboxEntry[],
  now: number
): readonly OutboxEntry[] =>
  entries
    .filter((entry) => entry.state === "pending" && entry.nextAttemptAt <= now)
    .toSorted(
      (left, right) =>
        left.createdAt - right.createdAt ||
        eventRank(left.event) - eventRank(right.event) ||
        left.channelId.localeCompare(right.channelId)
    );

/**
 * The earliest attempt of a pending row that is not waiting for its `down`
 * row. `entries` must include the `down` rows of every pending `up` row.
 */
export const outboxDueAt = (entries: readonly OutboxEntry[]): number | null => {
  const downs = downRows(entries);
  const times = entries
    .filter(
      (entry) =>
        entry.state === "pending" &&
        !(entry.event === "up" && downRowOf(entry, downs)?.state === "pending")
    )
    .map((entry) => entry.nextAttemptAt);
  return times.length === 0 ? null : Math.min(...times);
};

/**
 * Record one delivery attempt. Delivered and permanent failures are final;
 * other failures retry with backoff until the 8th attempt, then fail.
 */
export const afterAttempt = (
  entry: OutboxEntry,
  result: DeliveryResult,
  combined: boolean,
  now: number
): OutboxEntry => {
  const attempts = entry.attempts + 1;
  if (result._tag === "Delivered") {
    return {
      ...entry,
      attempts,
      combined,
      lastError: null,
      state: "delivered",
      updatedAt: now,
    };
  }
  const final = result.permanent || attempts >= maxAttempts;
  return {
    ...entry,
    attempts,
    lastError: result.error,
    nextAttemptAt: final ? entry.nextAttemptAt : now + backoffMs(attempts),
    state: final ? "failed" : "pending",
    updatedAt: now,
  };
};

/** Mark a row skipped (never sent). */
export const skipped = (
  entry: OutboxEntry,
  reason: string,
  now: number
): OutboxEntry => ({
  ...entry,
  lastError: reason,
  state: "skipped",
  updatedAt: now,
});

/**
 * The attempt could not be made (the Registry was unreachable while
 * resolving the channel): retry later without spending an attempt.
 */
export const deferred = (
  entry: OutboxEntry,
  error: string,
  now: number
): OutboxEntry => ({
  ...entry,
  lastError: error,
  nextAttemptAt: now + backoffMs(Math.max(1, entry.attempts)),
  updatedAt: now,
});

/**
 * How much delivery one alarm run does. Rows past `rowsPerRun`, or not
 * started within `budgetMs`, stay pending and due, so the re-armed alarm
 * fires again at once; the check step runs before delivery, so slow
 * channels cannot hold back checks.
 */
export interface DeliveryLimits {
  /** Stop starting attempts after this long; in-flight ones finish. */
  readonly budgetMs: number;
  /** Attempts in flight at once. */
  readonly concurrency: number;
  readonly rowsPerRun: number;
}

export const deliveryLimits: DeliveryLimits = {
  budgetMs: 30_000,
  concurrency: 5,
  rowsPerRun: 25,
};

/**
 * Due rows grouped per (incident, channel), each group and the groups in
 * `due` order. A group's rows run one after another (an `up` row reads
 * the outcome of its `down` row); different groups can run concurrently.
 */
export const deliveryGroups = (
  due: readonly OutboxEntry[]
): readonly (readonly OutboxEntry[])[] => {
  const groups = new Map<string, OutboxEntry[]>();
  for (const entry of due) {
    const group = groups.get(key(entry));
    if (group === undefined) {
      groups.set(key(entry), [entry]);
    } else {
      group.push(entry);
    }
  }
  return [...groups.values()];
};

/**
 * Attempt up to `rowsPerRun` of the due rows with bounded concurrency,
 * starting no attempt once `budgetMs` has passed. `attempt` must not fail
 * (it records its own outcome). Returns the rows attempted.
 */
export const deliverDue = <R>(
  due: readonly OutboxEntry[],
  attempt: (entry: OutboxEntry) => Effect.Effect<void, never, R>,
  limits: DeliveryLimits = deliveryLimits
): Effect.Effect<readonly OutboxEntry[], never, R> =>
  Effect.gen(function* deliverDueEffect() {
    const deadline = (yield* Clock.currentTimeMillis) + limits.budgetMs;
    const attempted: OutboxEntry[] = [];
    yield* Effect.forEach(
      deliveryGroups(due.slice(0, limits.rowsPerRun)),
      (group) =>
        Effect.forEach(
          group,
          (entry) =>
            Effect.gen(function* attemptWithinBudget() {
              if ((yield* Clock.currentTimeMillis) >= deadline) {
                return;
              }
              attempted.push(entry);
              yield* attempt(entry);
            }),
          { discard: true }
        ),
      { concurrency: limits.concurrency, discard: true }
    );
    return attempted;
  });
