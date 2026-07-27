/* oxlint-disable eslint/max-classes-per-file -- keep the small shared error vocabulary together */
import * as Schema from "effect/Schema";

export class MonitorNotFound extends Schema.TaggedErrorClass<MonitorNotFound>()(
  "MonitorNotFound",
  {
    monitorId: Schema.NonEmptyString,
  }
) {}

export class ProbeTimeout extends Schema.TaggedErrorClass<ProbeTimeout>()(
  "ProbeTimeout",
  {
    monitorId: Schema.NonEmptyString,
    timeoutMs: Schema.Int.check(
      Schema.isBetween({ maximum: 30_000, minimum: 1000 })
    ),
  }
) {}

export class ProbeFailed extends Schema.TaggedErrorClass<ProbeFailed>()(
  "ProbeFailed",
  {
    cause: Schema.Defect(),
    monitorId: Schema.NonEmptyString,
  }
) {}

export class AnalyticsIngestFailed extends Schema.TaggedErrorClass<AnalyticsIngestFailed>()(
  "AnalyticsIngestFailed",
  {
    cause: Schema.Defect(),
    datasource: Schema.Literals(["check_manifest", "checks"]),
  }
) {}

export class AlertDeliveryFailed extends Schema.TaggedErrorClass<AlertDeliveryFailed>()(
  "AlertDeliveryFailed",
  {
    cause: Schema.Defect(),
    channelId: Schema.NonEmptyString,
  }
) {}

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()(
  "DatabaseError",
  {
    cause: Schema.Defect(),
    operation: Schema.NonEmptyString,
  }
) {}
