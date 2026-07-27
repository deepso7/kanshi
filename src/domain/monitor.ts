import * as Schema from "effect/Schema";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const MonitorMethod = Schema.Literals(["GET", "HEAD"]);
export type MonitorMethod = typeof MonitorMethod.Type;

export const MonitorStatus = Schema.Literals(["unknown", "up", "down"]);
export type MonitorStatus = typeof MonitorStatus.Type;

export class Monitor extends Schema.Class<Monitor>("kanshi/domain/Monitor")({
  allowHttp: Schema.Boolean,
  createdAt: NonNegativeInt,
  deletedAt: Schema.NullOr(NonNegativeInt),
  enabled: Schema.Boolean,
  expectedStatus: Schema.Int.check(
    Schema.isBetween({ maximum: 599, minimum: 100 })
  ),
  failureStreak: NonNegativeInt,
  failureThreshold: Schema.Int.check(
    Schema.isBetween({ maximum: 10, minimum: 1 })
  ),
  id: Schema.NonEmptyString,
  intervalSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(60),
    Schema.isMultipleOf(60)
  ),
  lastCheckId: Schema.NullOr(Schema.NonEmptyString),
  method: MonitorMethod,
  name: Schema.NonEmptyString,
  nextCheckAt: NonNegativeInt,
  revision: PositiveInt,
  status: MonitorStatus,
  successStreak: NonNegativeInt,
  successThreshold: Schema.Int.check(
    Schema.isBetween({ maximum: 10, minimum: 1 })
  ),
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ maximum: 30_000, minimum: 1000 })
  ),
  updatedAt: NonNegativeInt,
  url: Schema.NonEmptyString,
}) {}
