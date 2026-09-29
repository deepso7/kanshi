/* oxlint-disable eslint/max-classes-per-file -- the API's error vocabulary lives with its spec */
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import {
  ChannelCreateInput,
  ChannelPatchInput,
  ChannelView,
} from "../domain/channel.ts";
import {
  Check,
  IncidentWithAlerts,
  RecentActivity,
  UptimeReport,
} from "../domain/history.ts";
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
import { Episode } from "../domain/watchdog.ts";
import { ApiAuth } from "./middleware.ts";

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

/**
 * A monitor's configuration, its `public` flag, its current state and
 * `notChecked`: the watchdog has an open "not being checked" episode for
 * it, or its state (read live) shows no check for longer than the
 * watchdog's stale threshold.
 */
export const MonitorResponse = Schema.Struct({
  ...MonitorConfig.fields,
  notChecked: Schema.Boolean,
  public: Schema.Boolean,
  state: MonitorState,
});
export type MonitorResponse = typeof MonitorResponse.Type;

/**
 * A monitor as listed (`GET /api/monitors`): identity and the Registry's
 * cached summary, and nothing else. The summary is pushed on status
 * changes and edits only, so it has no last check time; that is read live
 * by `GET /api/overview` and `GET /api/monitors/:id`.
 */
export const MonitorListItem = Schema.Struct({
  ...MonitorSummary.fields,
  id: Schema.String,
  key: Schema.String,
  managed: Schema.Boolean,
  /** The watchdog has an open "not being checked" episode for it. */
  notChecked: Schema.Boolean,
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
/** The dashboard's window: the last 24 hours in 48 half-hour buckets. */
export const defaultRecentHours = 24;
export const defaultRecentBuckets = 48;
export const defaultDevEventsLimit = 20;

/** `since`: epoch ms (inclusive); `limit`: newest first, 1..1000. */
const ChecksQuery = Schema.Struct({
  limit: intParam(1, 1000),
  since: intParam(0, Number.MAX_SAFE_INTEGER),
});
const UptimeQuery = Schema.Struct({ days: intParam(1, 365) });
const IncidentsQuery = Schema.Struct({ limit: intParam(1, 500) });
/** `hours`: the window, 1..168 (a week); `buckets`: 1..288. */
const RecentQuery = Schema.Struct({
  buckets: intParam(1, 288),
  hours: intParam(1, 168),
});

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
      error: [BadRequest, Conflict, NotFound, Unavailable],
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
    }),
    HttpApiEndpoint.get("recent", "/:id/recent", {
      error: NotFound,
      params: MonitorIdParams,
      query: RecentQuery,
      success: RecentActivity,
    })
  )
  .prefix("/api/monitors")
  .middleware(ApiAuth);

/** Monitors by displayed status (`paused` while disabled). */
export const StatusCounts = Schema.Struct({
  down: Schema.Number,
  paused: Schema.Number,
  unknown: Schema.Number,
  up: Schema.Number,
});
export type StatusCounts = typeof StatusCounts.Type;

/**
 * A dashboard row: the listed monitor, with its summary, last check time,
 * `notChecked` and recent activity read live from the monitor in one call
 * (the Registry's cached values when it could not be read). `notChecked`
 * is an open watchdog episode, or no check for longer than the watchdog's
 * stale threshold.
 */
export const OverviewMonitor = Schema.Struct({
  ...MonitorListItem.fields,
  /** Null when never checked, or when the monitor could not be read. */
  lastCheckedAt: Schema.NullOr(Schema.Number),
  /** Null when the monitor could not be read. */
  recent: Schema.NullOr(RecentActivity),
});
export type OverviewMonitor = typeof OverviewMonitor.Type;

/** `GET /api/overview`: every monitor with its recent activity. */
export const Overview = Schema.Struct({
  counts: StatusCounts,
  generatedAt: Schema.Number,
  monitors: Schema.Array(OverviewMonitor),
});
export type Overview = typeof Overview.Type;

/** The dashboard in one call (instead of one `recent` per monitor). */
const overviewGroup = HttpApiGroup.make("overview")
  .add(
    HttpApiEndpoint.get("get", "/", {
      query: RecentQuery,
      success: Overview,
    })
  )
  .prefix("/api/overview")
  .middleware(ApiAuth);

/** The watchdog's open "not being checked" episodes. */
const watchdogGroup = HttpApiGroup.make("watchdog")
  .add(
    HttpApiEndpoint.get("episodes", "/episodes", {
      success: Schema.Array(Episode),
    })
  )
  .prefix("/api/watchdog")
  .middleware(ApiAuth);

/** A request the dev webhook sink (`POST /_dev/webhook/*`) received. */
export const DevEventView = Schema.Struct({
  at: Schema.Number,
  /** The recorded request, as stored. */
  detail: Schema.Json,
  id: Schema.Number,
  kind: Schema.String,
  /** The alert's text (from `text`, `content` or `title`, or the body). */
  message: Schema.String,
  /** The sink URL's query string (e.g. `?tag=x`). */
  query: Schema.NullOr(Schema.String),
  /** The status the sink answered with. */
  respondedWith: Schema.NullOr(Schema.Number),
});
export type DevEventView = typeof DevEventView.Type;

const DevEventsQuery = Schema.Struct({ limit: intParam(1, 500) });

/**
 * Dev stage only: the webhook sink's latest events, newest first. Outside
 * dev mode it answers 404 (after auth).
 */
const devGroup = HttpApiGroup.make("dev")
  .add(
    HttpApiEndpoint.get("events", "/events", {
      error: NotFound,
      query: DevEventsQuery,
      success: Schema.Array(DevEventView),
    })
  )
  .prefix("/api/dev")
  .middleware(ApiAuth);

/** `GET /api/meta`: what the dashboard's forms need to know. */
export const Meta = Schema.Struct({
  devMode: Schema.Boolean,
  /** The smallest `intervalSeconds` a monitor accepts. */
  minIntervalSeconds: Schema.Number,
  /** The maximum number of monitors. */
  monitorQuota: Schema.Number,
});
export type Meta = typeof Meta.Type;

const metaGroup = HttpApiGroup.make("meta")
  .add(HttpApiEndpoint.get("get", "/", { success: Meta }))
  .prefix("/api/meta")
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

/** `GET /api/session`: whether the request carries a valid session. */
export const SessionState = Schema.Struct({ signedIn: Schema.Boolean });
export type SessionState = typeof SessionState.Type;

/** The longest token `POST /api/session` accepts. */
export const maxSignInTokenLength = 1024;

/**
 * `POST /api/session`: sign in with the API token. The body is capped
 * (`src/http/body-limit.ts`) before it is decoded.
 */
export const SignIn = Schema.Struct({
  token: Schema.String.check(Schema.isMaxLength(maxSignInTokenLength)),
});
export type SignIn = typeof SignIn.Type;

/**
 * The dashboard session cookie, for the SPA. No `ApiAuth`: signing in and
 * out are Origin-checked (403 otherwise); a wrong token is a 401, a sign-in
 * body over 4 KB a 413.
 */
const sessionGroup = HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("get", "/", {
      success: SessionState,
    }),
    HttpApiEndpoint.post("signIn", "/", {
      error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
      payload: SignIn.pipe(HttpApiSchema.asJson()),
      success: HttpApiSchema.NoContent,
    }),
    HttpApiEndpoint.delete("signOut", "/", {
      error: HttpApiError.Forbidden,
      success: HttpApiSchema.NoContent,
    })
  )
  .prefix("/api/session");

export const KanshiApi = HttpApi.make("KanshiApi")
  .add(monitorsGroup)
  .add(channelsGroup)
  .add(overviewGroup)
  .add(watchdogGroup)
  .add(devGroup)
  .add(metaGroup)
  .add(publicGroup)
  .add(sessionGroup);
