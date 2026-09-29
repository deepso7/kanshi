import * as Schema from "effect/Schema";

/** A monitor's alertable transitions. */
export const AlertEvent = Schema.Literals(["down", "up"]);
export type AlertEvent = typeof AlertEvent.Type;

export const OutboxState = Schema.Literals([
  "pending",
  "delivered",
  "failed",
  "skipped",
]);
export type OutboxState = typeof OutboxState.Type;

/**
 * The durable intent to alert, written in the same transaction as the
 * transition. The alarm resolves it into outbox rows (retrying with backoff
 * while the Registry is unreachable).
 */
export const Notification = Schema.Struct({
  attempts: Schema.Number,
  createdAt: Schema.Number,
  event: AlertEvent,
  incidentId: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  nextAttemptAt: Schema.Number,
  resolved: Schema.Boolean,
});
export type Notification = typeof Notification.Type;

/**
 * One alert to one channel. `combined` marks a `down` alert that was sent
 * after the incident had recovered and so already said so.
 */
export const OutboxEntry = Schema.Struct({
  attempts: Schema.Number,
  channelId: Schema.String,
  combined: Schema.Boolean,
  createdAt: Schema.Number,
  event: AlertEvent,
  incidentId: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  nextAttemptAt: Schema.Number,
  state: OutboxState,
  updatedAt: Schema.Number,
});
export type OutboxEntry = typeof OutboxEntry.Type;
