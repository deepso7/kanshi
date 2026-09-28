/* oxlint-disable eslint/max-classes-per-file -- the API's error vocabulary lives with its spec */
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import {
  ChannelCreateInput,
  ChannelPatchInput,
  ChannelView,
} from "../domain/channel.ts";
import { Check, IncidentWithAlerts, UptimeReport } from "../domain/history.ts";
import {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../domain/monitor-input.ts";
import {
  MonitorConfig,
  MonitorState,
  MonitorSummary,
} from "../domain/monitor.ts";
import { PublicStatus } from "../domain/public-status.ts";
import { ApiAuth } from "./auth.ts";

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  { httpApiStatus: 409 }
) {}

/**
 * The request was only partly applied and failed; retrying it is safe (its
 * writes are idempotent) and completes it.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { message: Schema.String },
  { httpApiStatus: 503 }
) {}

/** A monitor's configuration, its `public` flag and its current state. */
export const MonitorResponse = Schema.Struct({
  ...MonitorConfig.fields,
  public: Schema.Boolean,
  state: MonitorState,
});
export type MonitorResponse = typeof MonitorResponse.Type;

/** A monitor as listed: identity and the Registry's cached summary. */
export const MonitorListItem = Schema.Struct({
  ...MonitorSummary.fields,
  id: Schema.String,
  key: Schema.String,
  managed: Schema.Boolean,
  public: Schema.Boolean,
});
export type MonitorListItem = typeof MonitorListItem.Type;

const MonitorIdParams = Schema.Struct({ id: Schema.NonEmptyString });

/** An optional integer query parameter within bounds. */
const intParam = (minimum: number, maximum: number) =>
  Schema.optionalKey(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isBetween({ maximum, minimum })
    )
  );

export const defaultChecksLimit = 100;
export const defaultIncidentsLimit = 50;
export const defaultUptimeDays = 90;

/** `since`: epoch ms (inclusive); `limit`: newest first, 1..1000. */
const ChecksQuery = Schema.Struct({
  limit: intParam(1, 1000),
  since: intParam(0, Number.MAX_SAFE_INTEGER),
});
const UptimeQuery = Schema.Struct({ days: intParam(1, 365) });
const IncidentsQuery = Schema.Struct({ limit: intParam(1, 500) });

const monitorsGroup = HttpApiGroup.make("monitors")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(MonitorListItem),
    }),
    HttpApiEndpoint.post("create", "/", {
      error: [BadRequest, Conflict],
      payload: MonitorCreateInput.pipe(HttpApiSchema.asJson()),
      success: MonitorResponse.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("get", "/:id", {
      error: NotFound,
      params: MonitorIdParams,
      success: MonitorResponse,
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      error: [BadRequest, NotFound, Unavailable],
      params: MonitorIdParams,
      payload: MonitorPatchInput.pipe(HttpApiSchema.asJson()),
      success: MonitorResponse,
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      error: NotFound,
      params: MonitorIdParams,
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.post("check", "/:id/check", {
      error: [Conflict, NotFound],
      params: MonitorIdParams,
      success: MonitorResponse.pipe(HttpApiSchema.status(202)),
    }),
    HttpApiEndpoint.get("checks", "/:id/checks", {
      error: NotFound,
      params: MonitorIdParams,
      query: ChecksQuery,
      success: Schema.Array(Check),
    }),
    HttpApiEndpoint.get("uptime", "/:id/uptime", {
      error: NotFound,
      params: MonitorIdParams,
      query: UptimeQuery,
      success: UptimeReport,
    }),
    HttpApiEndpoint.get("incidents", "/:id/incidents", {
      error: NotFound,
      params: MonitorIdParams,
      query: IncidentsQuery,
      success: Schema.Array(IncidentWithAlerts),
    })
  )
  .prefix("/api/monitors")
  .middleware(ApiAuth);

/** The result of `POST /api/channels/:id/test`. */
export const ChannelTestResult = Schema.Struct({
  delivered: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Number),
});
export type ChannelTestResult = typeof ChannelTestResult.Type;

const ChannelIdParams = Schema.Struct({ id: Schema.NonEmptyString });

const channelsGroup = HttpApiGroup.make("channels")
  .add(
    HttpApiEndpoint.get("list", "/", {
      success: Schema.Array(ChannelView),
    }),
    HttpApiEndpoint.post("create", "/", {
      error: [BadRequest, Conflict],
      payload: ChannelCreateInput.pipe(HttpApiSchema.asJson()),
      success: ChannelView.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.patch("update", "/:id", {
      error: [BadRequest, NotFound, Unavailable],
      params: ChannelIdParams,
      payload: ChannelPatchInput.pipe(HttpApiSchema.asJson()),
      success: ChannelView,
    }),
    HttpApiEndpoint.delete("remove", "/:id", {
      error: NotFound,
      params: ChannelIdParams,
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.post("test", "/:id/test", {
      error: NotFound,
      params: ChannelIdParams,
      success: ChannelTestResult,
    })
  )
  .prefix("/api/channels")
  .middleware(ApiAuth);

/** No auth: only `public` monitors, never URLs. */
const publicGroup = HttpApiGroup.make("public")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      success: PublicStatus,
    })
  )
  .prefix("/api/public");

export const KanshiApi = HttpApi.make("KanshiApi")
  .add(monitorsGroup)
  .add(channelsGroup)
  .add(publicGroup);
