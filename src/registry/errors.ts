/* oxlint-disable eslint/max-classes-per-file -- the Registry DO's RPC error vocabulary */
import * as Schema from "effect/Schema";

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded",
  { quota: Schema.Number }
) {}

export const registryErrors = [QuotaExceeded];
