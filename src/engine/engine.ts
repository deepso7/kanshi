import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { probe } from "../domain/probe.ts";
import type { TinybirdClientConfig } from "../tinybird/client.ts";
import type { AlertDeliveryOptions } from "./alerts.ts";
import { deliverPendingAlerts } from "./alerts.ts";
import type { ClaimedMonitor } from "./scheduler.ts";
import { claimMonitors, selectDueMonitors } from "./scheduler.ts";
import { commitCheck } from "./state.ts";
import { ingestCheckManifest, ingestCheckSample } from "./tinybird.ts";

export interface EngineOptions extends AlertDeliveryOptions {
  readonly batchSize?: number;
  readonly beforeProbe?: (
    monitor: ClaimedMonitor
  ) => Effect.Effect<void, never, never>;
  readonly concurrency?: number;
}

const runClaimedMonitor = Effect.fn("Engine.runClaimedMonitor")(
  function* runClaimedMonitorEffect(
    tinybird: TinybirdClientConfig,
    monitor: ClaimedMonitor,
    options: EngineOptions
  ) {
    const checkId = crypto.randomUUID();

    yield* ingestCheckManifest(tinybird, {
      checkId,
      failureQuorum: 1,
      monitorId: monitor.id,
      regionsExpected: 1,
      revision: monitor.revision,
      scheduledAt: monitor.nextCheckAt,
    });
    if (options.beforeProbe) {
      yield* options.beforeProbe(monitor);
    }

    const result = yield* probe({
      allowHttp: monitor.allowHttp,
      checkId,
      expectedStatus: monitor.expectedStatus,
      method: monitor.method,
      monitorId: monitor.id,
      timeoutMs: monitor.timeoutMs,
      url: monitor.url,
    }).pipe(
      Effect.catchTag("ProbeFailed", (error) =>
        Effect.logError("Probe infrastructure failed", {
          monitorId: error.monitorId,
        }).pipe(Effect.as(null))
      )
    );
    if (result === null) {
      return;
    }

    yield* ingestCheckSample(tinybird, {
      monitorId: monitor.id,
      result,
      revision: monitor.revision,
      scheduledAt: monitor.nextCheckAt,
    });

    const committed = yield* commitCheck({
      checkedAt: result.probedAt,
      monitor,
      result,
    }).pipe(
      Effect.catchTag("DatabaseError", (error) =>
        Effect.logError("Failed to commit monitor result", {
          monitorId: monitor.id,
          operation: error.operation,
        }).pipe(Effect.as(null))
      )
    );
    if (committed === null) {
      return;
    }

    if (!committed) {
      yield* Effect.logDebug("Discarded stale monitor state update", {
        checkId,
        monitorId: monitor.id,
        revision: monitor.revision,
      });
    }
  }
);

export const runEngine = Effect.fn("Engine.run")(function* runEngineEffect(
  tinybird: TinybirdClientConfig,
  options: EngineOptions = {}
) {
  const batchSize = options.batchSize ?? 50;
  const concurrency = options.concurrency ?? 25;
  const now = yield* Clock.currentTimeMillis;
  const dueMonitors = yield* selectDueMonitors(now, batchSize);
  const claimedMonitors = yield* claimMonitors(dueMonitors, now);

  yield* Effect.annotateCurrentSpan({
    "engine.claimed_monitors": claimedMonitors.length,
    "engine.due_monitors": dueMonitors.length,
  });

  // oxlint-disable-next-line unicorn/no-array-for-each -- this is Effect's bounded concurrent traversal
  yield* Effect.forEach(
    claimedMonitors,
    (monitor) => runClaimedMonitor(tinybird, monitor, options),
    {
      concurrency,
      discard: true,
    }
  );

  yield* deliverPendingAlerts({
    validateWebhook: options.validateWebhook,
  }).pipe(
    Effect.catchTag("DatabaseError", (error) =>
      Effect.logError("Alert delivery batch failed", {
        operation: error.operation,
      })
    )
  );
});
