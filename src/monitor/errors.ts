/* oxlint-disable eslint/max-classes-per-file -- the Monitor DO's RPC error vocabulary */
import * as Schema from "effect/Schema";

/** The monitor was deleted; it accepts no further configuration. */
export class MonitorTombstoned extends Schema.TaggedError<MonitorTombstoned>()(
  "MonitorTombstoned",
  { monitorId: Schema.String }
) {}

/** The object was never configured (no such monitor). */
export class MonitorNotConfigured extends Schema.TaggedError<MonitorNotConfigured>()(
  "MonitorNotConfigured",
  {}
) {}

export class MonitorDisabled extends Schema.TaggedError<MonitorDisabled>()(
  "MonitorDisabled",
  { monitorId: Schema.String }
) {}

export class InvalidMonitorInput extends Schema.TaggedError<InvalidMonitorInput>()(
  "InvalidMonitorInput",
  { message: Schema.String }
) {}

/** `configure` was called for a different monitor id than the stored one. */
export class MonitorIdMismatch extends Schema.TaggedError<MonitorIdMismatch>()(
  "MonitorIdMismatch",
  { expected: Schema.String, received: Schema.String }
) {}

export const monitorErrors = [
  InvalidMonitorInput,
  MonitorDisabled,
  MonitorIdMismatch,
  MonitorNotConfigured,
  MonitorTombstoned,
];
