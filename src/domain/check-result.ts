import * as Schema from "effect/Schema";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const CheckErrorKind = Schema.Literals([
  "blocked",
  "connection",
  "dns",
  "network",
  "redirect",
  "response_too_large",
  "timeout",
  "tls",
]);
export type CheckErrorKind = typeof CheckErrorKind.Type;

export class CheckResult extends Schema.Class<CheckResult>(
  "kanshi/domain/CheckResult"
)({
  checkId: Schema.NonEmptyString,
  errorKind: Schema.NullOr(CheckErrorKind),
  latencyMs: Schema.NullOr(NonNegativeInt),
  ok: Schema.Boolean,
  probedAt: NonNegativeInt,
  status: Schema.NullOr(
    Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 100 }))
  ),
}) {}
