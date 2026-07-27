import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import { Monitor } from "../domain/monitor.ts";
import { ApiAuth } from "./auth.ts";

const { NonEmptyString } = Schema;
const ExpectedStatus = Schema.Int.check(
  Schema.isBetween({ maximum: 599, minimum: 100 })
);
const IntervalSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(60),
  Schema.isMultipleOf(60)
);
const Threshold = Schema.Int.check(
  Schema.isBetween({ maximum: 10, minimum: 1 })
);
const TimeoutMs = Schema.Int.check(
  Schema.isBetween({ maximum: 30_000, minimum: 1000 })
);
const MonitorIdParams = Schema.Struct({ id: NonEmptyString });
const ChannelParams = Schema.Struct({
  channelId: NonEmptyString,
  id: NonEmptyString,
});

export const CreateMonitorPayload = Schema.Struct({
  allowHttp: Schema.optionalKey(Schema.Boolean),
  expectedStatus: Schema.optionalKey(ExpectedStatus),
  failureThreshold: Schema.optionalKey(Threshold),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  method: Schema.optionalKey(Schema.Literals(["GET", "HEAD"])),
  name: NonEmptyString,
  successThreshold: Schema.optionalKey(Threshold),
  timeoutMs: Schema.optionalKey(TimeoutMs),
  url: NonEmptyString,
}).pipe(HttpApiSchema.asJson());

export const UpdateMonitorPayload = Schema.Struct({
  allowHttp: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  expectedStatus: Schema.optionalKey(ExpectedStatus),
  failureThreshold: Schema.optionalKey(Threshold),
  intervalSeconds: Schema.optionalKey(IntervalSeconds),
  method: Schema.optionalKey(Schema.Literals(["GET", "HEAD"])),
  name: Schema.optionalKey(NonEmptyString),
  successThreshold: Schema.optionalKey(Threshold),
  timeoutMs: Schema.optionalKey(TimeoutMs),
  url: Schema.optionalKey(NonEmptyString),
}).pipe(HttpApiSchema.asJson());

export const AlertChannel = Schema.Struct({
  enabled: Schema.Boolean,
  id: NonEmptyString,
  kind: Schema.Literals(["slack", "discord"]),
  monitorId: NonEmptyString,
});

export const LiveStatus = Schema.Struct({
  failureStreak: Schema.Int,
  lastCheckId: Schema.NullOr(Schema.String),
  openIncident: Schema.NullOr(
    Schema.Struct({
      cause: Schema.String,
      id: Schema.String,
      startedAt: Schema.Int,
    })
  ),
  status: Schema.Literals(["unknown", "up", "down"]),
  successStreak: Schema.Int,
});

const HistoryQuery = Schema.Struct({
  cursor: Schema.optionalKey(Schema.String),
  end: NonEmptyString,
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
  ),
  start: NonEmptyString,
});

const UptimeQuery = Schema.Struct({
  bucket: Schema.Literals(["1m", "5m", "1h", "1d"]),
  end: NonEmptyString,
  start: NonEmptyString,
});

export const HistoryRow = Schema.Struct({
  check_id: Schema.String,
  cursor: Schema.String,
  error_kind: Schema.NullOr(Schema.String),
  ingested_at: Schema.String,
  latency_ms: Schema.NullOr(Schema.Int),
  monitor_id: Schema.String,
  ok: Schema.Int,
  probed_at: Schema.String,
  region: Schema.String,
  revision: Schema.Int,
  scheduled_at: Schema.String,
  status: Schema.NullOr(Schema.Int),
});

export const UptimeRow = Schema.Struct({
  bucket_start: Schema.String,
  checks_down: Schema.Int,
  checks_expected: Schema.Int,
  checks_unknown: Schema.Int,
  checks_up: Schema.Int,
  p50_latency_ms: Schema.NullOr(Schema.Int),
  p95_latency_ms: Schema.NullOr(Schema.Int),
  p99_latency_ms: Schema.NullOr(Schema.Int),
  regions_expected: Schema.Int,
  regions_observed: Schema.Int,
  uptime_ratio: Schema.NullOr(Schema.Number),
});

export const CreateChannelPayload = Schema.Struct({
  kind: Schema.Literals(["slack", "discord"]),
  webhookUrl: NonEmptyString,
}).pipe(HttpApiSchema.asJson());

const monitorsGroup = HttpApiGroup.make("monitors")
  .add(
    HttpApiEndpoint.get("list", "/monitors", {
      success: Schema.Array(Monitor),
    }),
    HttpApiEndpoint.post("create", "/monitors", {
      error: [HttpApiError.BadRequestNoContent, HttpApiError.ConflictNoContent],
      payload: CreateMonitorPayload,
      success: Monitor,
    }),
    HttpApiEndpoint.get("get", "/monitors/:id", {
      error: HttpApiError.NotFoundNoContent,
      params: MonitorIdParams,
      success: Monitor,
    }),
    HttpApiEndpoint.patch("update", "/monitors/:id", {
      error: [HttpApiError.BadRequestNoContent, HttpApiError.NotFoundNoContent],
      params: MonitorIdParams,
      payload: UpdateMonitorPayload,
      success: Monitor,
    }),
    HttpApiEndpoint.delete("remove", "/monitors/:id", {
      error: HttpApiError.NotFoundNoContent,
      params: MonitorIdParams,
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.get("listChannels", "/monitors/:id/channels", {
      error: HttpApiError.NotFoundNoContent,
      params: MonitorIdParams,
      success: Schema.Array(AlertChannel),
    }),
    HttpApiEndpoint.post("createChannel", "/monitors/:id/channels", {
      error: [HttpApiError.BadRequestNoContent, HttpApiError.NotFoundNoContent],
      params: MonitorIdParams,
      payload: CreateChannelPayload,
      success: AlertChannel,
    }),
    HttpApiEndpoint.delete(
      "removeChannel",
      "/monitors/:id/channels/:channelId",
      {
        error: HttpApiError.NotFoundNoContent,
        params: ChannelParams,
        success: HttpApiSchema.NoContent,
      }
    )
  )
  .middleware(ApiAuth);

const statusGroup = HttpApiGroup.make("status")
  .add(
    HttpApiEndpoint.get("live", "/monitors/:id/status", {
      error: HttpApiError.NotFoundNoContent,
      params: MonitorIdParams,
      success: LiveStatus,
    }),
    HttpApiEndpoint.get("history", "/monitors/:id/history", {
      error: [HttpApiError.BadRequestNoContent, HttpApiError.NotFoundNoContent],
      params: MonitorIdParams,
      query: HistoryQuery,
      success: Schema.Array(HistoryRow),
    }),
    HttpApiEndpoint.get("uptime", "/monitors/:id/uptime", {
      error: [HttpApiError.BadRequestNoContent, HttpApiError.NotFoundNoContent],
      params: MonitorIdParams,
      query: UptimeQuery,
      success: Schema.Array(UptimeRow),
    })
  )
  .middleware(ApiAuth);

export const KanshiApi = HttpApi.make("KanshiApi")
  .add(monitorsGroup)
  .add(statusGroup);
