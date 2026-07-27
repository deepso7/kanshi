import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { HttpClientError } from "effect/unstable/http";

import type { CheckResult } from "../domain/check-result.ts";
import { AnalyticsIngestFailed } from "../domain/errors.ts";
import type {
  TinybirdClientConfig,
  TinybirdDatasource,
} from "../tinybird/client.ts";
import {
  appendRows,
  formatDateTime64,
  TinybirdRowsQuarantined,
} from "../tinybird/client.ts";

export interface CheckManifestInput {
  readonly checkId: string;
  readonly failureQuorum: number;
  readonly monitorId: string;
  readonly regionsExpected: number;
  readonly revision: number;
  readonly scheduledAt: number;
}

export interface CheckSampleInput {
  readonly monitorId: string;
  readonly result: CheckResult;
  readonly revision: number;
  readonly scheduledAt: number;
}

const retrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered
);

const isTransient = (error: unknown): boolean => {
  if (!HttpClientError.isHttpClientError(error)) {
    return false;
  }

  if (error.reason._tag === "TransportError") {
    return true;
  }

  if (error.reason._tag === "StatusCodeError") {
    const { status } = error.reason.response;
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  return (
    error.reason._tag === "DecodeError" ||
    error.reason._tag === "EmptyBodyError"
  );
};

const append = Effect.fn("Tinybird.append")(function* appendEffect(
  config: TinybirdClientConfig,
  datasource: TinybirdDatasource,
  row: Readonly<Record<string, unknown>>
) {
  return yield* appendRows(config, datasource, [row]).pipe(
    Effect.retry({
      schedule: retrySchedule,
      times: 2,
      while: isTransient,
    }),
    Effect.mapError((error) =>
      error instanceof TinybirdRowsQuarantined
        ? error
        : new AnalyticsIngestFailed({
            cause: error,
            datasource,
          })
    ),
    Effect.tapError((error) =>
      error instanceof TinybirdRowsQuarantined
        ? Effect.void
        : Effect.logError("Tinybird ingestion failed", {
            datasource,
          })
    ),
    Effect.ignore
  );
});

export const ingestCheckManifest = Effect.fn("Tinybird.ingestCheckManifest")(
  function* ingestCheckManifestEffect(
    config: TinybirdClientConfig,
    input: CheckManifestInput
  ) {
    const enqueuedAt = yield* Clock.currentTimeMillis;
    yield* append(config, "check_manifest", {
      check_id: input.checkId,
      enqueued_at: formatDateTime64(enqueuedAt),
      failure_quorum: input.failureQuorum,
      monitor_id: input.monitorId,
      regions_expected: input.regionsExpected,
      revision: input.revision,
      scheduled_at: formatDateTime64(input.scheduledAt),
    });
  }
);

export const ingestCheckSample = Effect.fn("Tinybird.ingestCheckSample")(
  function* ingestCheckSampleEffect(
    config: TinybirdClientConfig,
    input: CheckSampleInput
  ) {
    const ingestedAt = yield* Clock.currentTimeMillis;
    yield* append(config, "checks", {
      check_id: input.result.checkId,
      error_kind: input.result.errorKind,
      ingested_at: formatDateTime64(ingestedAt),
      latency_ms: input.result.latencyMs,
      monitor_id: input.monitorId,
      ok: input.result.ok ? 1 : 0,
      probed_at: formatDateTime64(input.result.probedAt),
      region: "auto",
      revision: input.revision,
      scheduled_at: formatDateTime64(input.scheduledAt),
      status: input.result.status,
    });
  }
);
