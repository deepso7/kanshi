/* oxlint-disable sort-keys -- schema column order mirrors the ingestion contract */
import { defineDatasource, engine, t } from "@tinybirdco/sdk";

import { analyticsAppendToken } from "./tokens.ts";

export const checkManifest = defineDatasource("check_manifest", {
  description: "Checks claimed by the scheduler before probing begins",
  schema: {
    check_id: t.string(),
    monitor_id: t.string(),
    scheduled_at: t.dateTime64(3),
    regions_expected: t.uint8(),
    failure_quorum: t.uint8(),
    revision: t.uint32(),
    enqueued_at: t.dateTime64(3),
  },
  engine: engine.replacingMergeTree({
    partitionKey: "toYYYYMM(scheduled_at)",
    sortingKey: ["monitor_id", "check_id"],
    ver: "enqueued_at",
  }),
  tokens: [{ token: analyticsAppendToken, scope: "APPEND" }],
});

export const checks = defineDatasource("checks", {
  description: "Observed HTTP probe results",
  schema: {
    check_id: t.string(),
    monitor_id: t.string(),
    region: t.string().lowCardinality(),
    scheduled_at: t.dateTime64(3),
    probed_at: t.dateTime64(3),
    ingested_at: t.dateTime64(3),
    ok: t.uint8(),
    status: t.uint16().nullable(),
    latency_ms: t.uint32().nullable(),
    error_kind: t.string().lowCardinality().nullable(),
    revision: t.uint32(),
  },
  engine: engine.replacingMergeTree({
    partitionKey: "toYYYYMM(scheduled_at)",
    sortingKey: ["monitor_id", "check_id", "region"],
    ver: "ingested_at",
  }),
  tokens: [{ token: analyticsAppendToken, scope: "APPEND" }],
});
