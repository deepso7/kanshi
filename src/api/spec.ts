/* oxlint-disable eslint/max-classes-per-file -- the API's error vocabulary lives with its spec */
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../domain/monitor-input.ts";
import {
  MonitorConfig,
  MonitorState,
  MonitorSummary,
} from "../domain/monitor.ts";
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
      error: [BadRequest, NotFound],
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
    })
  )
  .prefix("/api/monitors")
  .middleware(ApiAuth);

export const KanshiApi = HttpApi.make("KanshiApi").add(monitorsGroup);
