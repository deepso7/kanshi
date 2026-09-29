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

/**
 * The per-monitor status cached by the Registry: only fields that change
 * with a status transition or an edit, never per check (`lastCheckedAt` is
 * read live from the monitor), so a check that changes nothing needs no
 * push.
 */
export const MonitorSummary = Schema.Struct({
  enabled: Schema.Boolean,
  intervalSeconds: NonNegativeInt,
  name: Schema.String,
  status: MonitorStatus,
  /** The target URL (empty on a row not refreshed since migration 4). */
  url: Schema.String,
});
export type MonitorSummary = typeof MonitorSummary.Type;

/** A monitor's status as shown: `paused` while disabled. */
export const DisplayStatus = Schema.Literals([
  "up",
  "down",
  "unknown",
  "paused",
]);
export type DisplayStatus = typeof DisplayStatus.Type;

export const displayStatus = (
  summary: Pick<MonitorSummary, "enabled" | "status">
): DisplayStatus => (summary.enabled ? summary.status : "paused");

export const summaryOf = (
  config: MonitorConfig,
  state: MonitorState
): MonitorSummary => ({
  enabled: config.enabled,
  intervalSeconds: config.intervalSeconds,
  name: config.name,
  status: state.status,
  url: config.url,
});

/** Whether two summaries differ in any field the Registry stores. */
export const summaryChanged = (
  before: MonitorSummary,
  after: MonitorSummary
): boolean =>
  before.enabled !== after.enabled ||
  before.intervalSeconds !== after.intervalSeconds ||
  before.name !== after.name ||
  before.status !== after.status ||
  before.url !== after.url;

/**
 * `after` with its `summaryRevision` bumped by one when the summary changed
 * from `before` (a status transition, enable/disable, or an edit of the
 * name, URL or interval), and kept otherwise. The revision is what the
 * Registry orders pushes and watchdog observations by, so it only moves
 * when there is something new to push.
 *
 * The one exception: a change that `revived` a monitor the watchdog would
 * call stale (the first check or schedule restart after a long gap; see
 * `revives`) bumps it once even though no summary field moved. It is then
 * pushed, and the watchdog rejects an observation read before it (older
 * revision) instead of alerting a monitor that is checked again. The next
 * check finds the monitor fresh, so it does not bump again.
 */
export const reviseSummary = (
  before: { readonly config: MonitorConfig; readonly state: MonitorState },
  after: { readonly config: MonitorConfig; readonly state: MonitorState },
  revived: boolean
): MonitorState => ({
  ...after.state,
  summaryRevision:
    before.state.summaryRevision +
    (revived ||
    summaryChanged(
      summaryOf(before.config, before.state),
      summaryOf(after.config, after.state)
    )
      ? 1
      : 0),
});

/** A monitor's full view: its configuration and its current state. */
export const MonitorSnapshot = Schema.Struct({
  config: MonitorConfig,
  state: MonitorState,
});
export type MonitorSnapshot = typeof MonitorSnapshot.Type;

/**
 * Whether the Monitor pushes its summary to the Registry after a change
 * from `before` (null: the monitor was just configured) to `after`: only
 * when the summary revision moved, i.e. a Registry-visible field changed or
 * a stale monitor was revived. A check that leaves the status alone does
 * not push (unless it ends a stale gap); a status transition,
 * enable/disable or an edit of the name, URL or interval does.
 */
export const shouldPushSummary = (
  before: MonitorSnapshot | null,
  after: MonitorSnapshot
): boolean =>
  before === null || after.state.summaryRevision > before.state.summaryRevision;

/**
 * The summary revision a Monitor still owes the Registry after a push of
 * `revision` failed (`owed`: what it already owed, or null). Pushes can run
 * concurrently (an edit's and a check's), so the newest failed one counts.
 */
export const owePush = (owed: number | null, revision: number): number =>
  owed === null ? revision : Math.max(owed, revision);

/**
 * What is still owed after a push of `revision` succeeded: nothing if it
 * covers the owed revision, otherwise the owed one (a newer push failed
 * and this older one finished after it).
 */
export const settlePush = (
  owed: number | null,
  revision: number
): number | null => (owed !== null && owed > revision ? owed : null);
