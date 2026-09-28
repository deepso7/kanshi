/* oxlint-disable eslint/max-classes-per-file -- the Registry DO's RPC error vocabulary */
import * as Schema from "effect/Schema";

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  { quota: Schema.Number }
) {}

export class KeyTaken extends Schema.TaggedError<KeyTaken>()("KeyTaken", {
  key: Schema.String,
}) {}

export const registryErrors = [KeyTaken, QuotaExceeded];
