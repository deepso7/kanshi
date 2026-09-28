import * as Schema from "effect/Schema";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const MonitorMethod = Schema.Literals(["GET", "HEAD"]);
export type MonitorMethod = typeof MonitorMethod.Type;

export const MonitorStatus = Schema.Literals(["unknown", "up", "down"]);
export type MonitorStatus = typeof MonitorStatus.Type;

/** What produced a check: its slot, the confirm of a failure, or run-now. */
export const CheckKind = Schema.Literals(["scheduled", "confirm", "manual"]);
export type CheckKind = typeof CheckKind.Type;

export const NextCheckKind = Schema.Literals(["scheduled", "confirm"]);
export type NextCheckKind = typeof NextCheckKind.Type;

export const CheckErrorKind = Schema.Literals([
  "connection",
  "dns",
  "keyword",
  "network",
  "status",
  "timeout",
  "tls",
]);
export type CheckErrorKind = typeof CheckErrorKind.Type;

export const IncidentResolution = Schema.Literals([
  "recovered",
  "disabled",
  "deleted",
]);
export type IncidentResolution = typeof IncidentResolution.Type;

/** `all` channels, or an explicit list of channel ids. */
export const ChannelSelection = Schema.Union([
  Schema.Literal("all"),
  Schema.Array(Schema.NonEmptyString),
]);
export type ChannelSelection = typeof ChannelSelection.Type;

/** What a single probe observed. */
export const ProbeOutcome = Schema.Struct({
  errorKind: Schema.NullOr(CheckErrorKind),
  latencyMs: Schema.NullOr(NonNegativeInt),
  message: Schema.NullOr(Schema.String),
  ok: Schema.Boolean,
  status: Schema.NullOr(Schema.Int),
});
export type ProbeOutcome = typeof ProbeOutcome.Type;

export const LastResult = Schema.Struct({
  ...ProbeOutcome.fields,
  at: NonNegativeInt,
  checkId: Schema.NonEmptyString,
  kind: CheckKind,
});
export type LastResult = typeof LastResult.Type;

export const Inflight = Schema.Struct({
  checkId: Schema.NonEmptyString,
  generation: NonNegativeInt,
  kind: CheckKind,
  startedAt: NonNegativeInt,
});
export type Inflight = typeof Inflight.Type;

/**
 * Everything the monitor is told to do. `generation` is bumped by every edit
 * that affects probing, so an in-flight probe of an older configuration can
 * be recognised and discarded.
 */
export const MonitorConfig = Schema.Struct({
  bodyContains: Schema.NullOr(Schema.String),
  channels: ChannelSelection,
  createdAt: NonNegativeInt,
  enabled: Schema.Boolean,
  expectedStatus: Schema.String,
  failureThreshold: NonNegativeInt,
  generation: NonNegativeInt,
  id: Schema.NonEmptyString,
  intervalSeconds: NonNegativeInt,
  key: Schema.NonEmptyString,
  managed: Schema.Boolean,
  method: MonitorMethod,
  name: Schema.NonEmptyString,
  successThreshold: NonNegativeInt,
  timeoutMs: NonNegativeInt,
  updatedAt: NonNegativeInt,
  url: Schema.NonEmptyString,
});
export type MonitorConfig = typeof MonitorConfig.Type;

/**
 * The monitor's runtime state. `nextCheckAt`/`nextCheckKind` name the next
 * due check; while a confirm is pending, `nextSlotAt` keeps the scheduled
 * slot that follows it and `confirmCounted` says whether the confirm stands
 * in for a scheduled slot (true) or follows a manual check (false).
 */
export const MonitorState = Schema.Struct({
  confirmCounted: Schema.Boolean,
  failureStreak: NonNegativeInt,
  inflight: Schema.NullOr(Inflight),
  lastCheckedAt: Schema.NullOr(NonNegativeInt),
  lastResult: Schema.NullOr(LastResult),
  manualRequestedAt: Schema.NullOr(NonNegativeInt),
  nextCheckAt: NonNegativeInt,
  nextCheckKind: NextCheckKind,
  nextMaintenanceAt: Schema.NullOr(NonNegativeInt),
  nextSlotAt: NonNegativeInt,
  openIncidentId: Schema.NullOr(Schema.String),
  rolledUpThrough: Schema.NullOr(Schema.String),
  /**
   * When the check schedule last restarted: creation, enable, disable or a
   * probe-affecting edit. Cosmetic edits leave it alone.
   */
  scheduleResetAt: NonNegativeInt,
  status: MonitorStatus,
  successStreak: NonNegativeInt,
  summaryRevision: NonNegativeInt,
});
export type MonitorState = typeof MonitorState.Type;

/** The per-monitor status cached by the Registry. */
export const MonitorSummary = Schema.Struct({
  enabled: Schema.Boolean,
  intervalSeconds: NonNegativeInt,
  lastCheckedAt: Schema.NullOr(NonNegativeInt),
  name: Schema.String,
  status: MonitorStatus,
});
export type MonitorSummary = typeof MonitorSummary.Type;

export const summaryOf = (
  config: MonitorConfig,
  state: MonitorState
): MonitorSummary => ({
  enabled: config.enabled,
  intervalSeconds: config.intervalSeconds,
  lastCheckedAt: state.lastCheckedAt,
  name: config.name,
  status: state.status,
});

/** A monitor's full view: its configuration and its current state. */
export const MonitorSnapshot = Schema.Struct({
  config: MonitorConfig,
  state: MonitorState,
});
export type MonitorSnapshot = typeof MonitorSnapshot.Type;
