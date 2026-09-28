import type { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { requestIsSameOrigin, tokenMatches } from "../api/auth.ts";
import type {
  BadRequest,
  Conflict,
  MonitorResponse,
  NotFound,
  Unavailable,
} from "../api/spec.ts";
import type { FormBody } from "../http/body.ts";
import { discardBody, maxFormBytes, readFormBody } from "../http/body.ts";
import { matchPattern } from "../http/route.ts";
import type { Registry } from "../registry/registry.ts";
import { registryName } from "../registry/registry.ts";
import type { ChannelService } from "../service/channels.ts";
import type { MonitorService } from "../service/monitors.ts";
import type { StatusService } from "../service/status.ts";
import type { FormFields } from "./forms.ts";
import {
  channelCreateFromForm,
  channelPatchFromForm,
  monitorCreateFromForm,
  monitorPatchFromForm,
} from "./forms.ts";
import type { Html } from "./html.ts";
import { html } from "./html.ts";
import type { Flash } from "./layout.ts";
import { page } from "./layout.ts";
import type { ChannelsData, DashboardRow } from "./pages.ts";
import {
  channelsPage,
  dashboardPage,
  defaultMonitorValues,
  forbiddenPage,
  loginPage,
  monitorFormPage,
  monitorPage,
  monitorValues,
  notFoundPage,
  submittedMonitorValues,
} from "./pages.ts";
import {
  clearedSessionCookie,
  makeSession,
  sessionCookie,
  sessionCookieName,
  verifySession,
} from "./session.ts";
import { statusPage } from "./status-page.ts";

export interface UiDeps {
  readonly apiToken: Redacted.Redacted<string>;
  readonly channels: ChannelService;
  readonly devMode: boolean;
  readonly monitors: MonitorService;
  readonly registries: Effect.Success<typeof Registry>;
  readonly status: StatusService;
}

type ServiceError = BadRequest | Conflict | NotFound | Unavailable;

/** Headers on every HTML page: never cached, never framed. */
const pageHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export const htmlResponse = (
  body: Html,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
) =>
  HttpServerResponse.text(body.value, {
    contentType: "text/html; charset=utf-8",
    headers: { ...pageHeaders, ...headers },
    status,
  });

const seeOther = (
  location: string,
  headers: Readonly<Record<string, string>> = {}
) =>
  HttpServerResponse.redirect(location, {
    headers: { "cache-control": "no-store", ...headers },
    status: 303,
  });

/** Success messages after a redirect, by `?done=` code (never echoed). */
const doneMessages: Readonly<Record<string, string>> = {
  "channel-created": "Channel added.",
  "channel-deleted": "Channel deleted.",
  "channel-saved": "Channel saved.",
  checked: "Check requested; the result shows up in a few seconds.",
  created: "Monitor created.",
  deleted: "Monitor deleted.",
  paused: "Monitor paused.",
  private: "Removed from the public status page.",
  public: "Now shown on the public status page.",
  resumed: "Monitor resumed.",
  saved: "Changes saved.",
};

const flashFrom = (url: URL): Flash | null => {
  const text = doneMessages[url.searchParams.get("done") ?? ""];
  return text === undefined ? null : { kind: "ok", text };
};

const errorPage = (status: number, title: string, text: string) =>
  htmlResponse(
    page({
      body: html`<div class="panel empty">
        <h1>${title}</h1>
        <p>${text}</p>
        <p><a href="/">Back to monitors</a></p>
      </div>`,
      section: "dashboard",
      title,
    }),
    status
  );

interface RouteInput {
  readonly form: FormFields;
  readonly params: readonly string[];
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}

type Handler = (
  input: RouteInput
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  ServiceError,
  RuntimeContext
>;

type Route = readonly [method: "GET" | "POST", pattern: string, Handler];

const param = (input: RouteInput, index = 0): string => {
  const value = input.params[index] ?? "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const monitorPath = (id: string) => `/monitors/${encodeURIComponent(id)}`;

const logout = () =>
  Effect.succeed(seeOther("/login", { "set-cookie": clearedSessionCookie() }));

/** `""` is the root path; anything else is a `matchPattern` pattern. */
const matchRoute = (pattern: string, segments: readonly string[]) => {
  if (pattern === "") {
    return segments.length === 0 ? [] : null;
  }
  return matchPattern(pattern, segments);
};

const find = (
  routes: readonly Route[],
  method: string,
  segments: readonly string[]
) => {
  for (const [routeMethod, pattern, handle] of routes) {
    const matched = matchRoute(pattern, segments);
    if (
      matched !== null &&
      (routeMethod === method || (routeMethod === "GET" && method === "HEAD"))
    ) {
      return { handle, params: matched };
    }
  }
  return null;
};

/**
 * Read and drop the body of a post we are rejecting without buffering it:
 * answering with an unread body makes some proxies (the local dev gateway
 * among them) reset the connection.
 */
const discardRequestBody = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap((web) => Effect.promise(() => discardBody(web.body))),
    Effect.ignore
  );

const readForm = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.flatMap((web) => Effect.promise(() => readFormBody(web))),
    Effect.orElseSucceed((): FormBody => ({ _tag: "Form", fields: [] }))
  );

const run = (
  handle: Handler,
  input: Omit<RouteInput, "form">,
  isPost: boolean
) =>
  Effect.gen(function* runRoute() {
    if (isPost && !requestIsSameOrigin(input.request)) {
      yield* discardRequestBody(input.request);
      return htmlResponse(forbiddenPage(), 403);
    }
    let form: FormFields = [];
    if (isPost) {
      const body = yield* readForm(input.request);
      if (body._tag === "TooLarge") {
        return errorPage(
          413,
          "Form too large",
          `Form posts are limited to ${maxFormBytes / 1024} KB.`
        );
      }
      form = body.fields;
    }
    return yield* handle({ ...input, form }).pipe(
      Effect.catchTags({
        BadRequest: (error) =>
          Effect.succeed(errorPage(400, "Bad request", error.message)),
        Conflict: (error) =>
          Effect.succeed(errorPage(409, "Conflict", error.message)),
        NotFound: () => Effect.succeed(htmlResponse(notFoundPage(true), 404)),
        Unavailable: (error) =>
          Effect.succeed(errorPage(503, "Please try again", error.message)),
      })
    );
  });

/**
 * The dashboard (session cookie) and the public status page. Every form
 * post must pass the Origin check; signed-in pages redirect to `/login`
 * without a valid session. Pages call the same services as `/api`.
 */
export const makeUiRoutes = (deps: UiDeps) => {
  const token = Redacted.value(deps.apiToken);
  const registry = () => deps.registries.getByName(registryName);

  const hasSession = (request: HttpServerRequest.HttpServerRequest) => {
    const value = request.cookies[sessionCookieName];
    return value === undefined
      ? Effect.succeed(false)
      : verifySession(token, value, Date.now());
  };

  // -- public ---------------------------------------------------------------

  const statusRoute = () =>
    deps.status
      .publicStatus()
      .pipe(Effect.map((status) => htmlResponse(statusPage(status))));

  const loginForm = (input: RouteInput) =>
    hasSession(input.request).pipe(
      Effect.map((signedIn) =>
        signedIn ? seeOther("/") : htmlResponse(loginPage(null))
      )
    );

  const login = (input: RouteInput) =>
    Effect.gen(function* loginRoute() {
      const submitted = input.form.find(([key]) => key === "token")?.[1] ?? "";
      if (submitted.trim() === "" || !tokenMatches(deps.apiToken, submitted)) {
        yield* Effect.logWarning("dashboard sign-in with a wrong token");
        return htmlResponse(loginPage("That token is not valid."), 401);
      }
      const session = yield* makeSession(token, Date.now());
      return seeOther("/", { "set-cookie": sessionCookie(session) });
    });

  // -- dashboard ------------------------------------------------------------

  const dashboard = (input: RouteInput) =>
    Effect.gen(function* dashboardRoute() {
      const entries = yield* deps.monitors.list();
      const rows = yield* Effect.forEach(
        entries,
        (entry) =>
          deps.monitors.recent(entry.id).pipe(
            Effect.catchCause(() => Effect.succeed(null)),
            Effect.map((recent): DashboardRow => ({ entry, recent }))
          ),
        { concurrency: 8 }
      );
      const devEvents = deps.devMode
        ? (yield* registry().devEvents()).slice(-20).toReversed()
        : null;
      return htmlResponse(
        dashboardPage({
          devEvents,
          flash: flashFrom(input.url),
          now: Date.now(),
          rows,
        })
      );
    });

  const monitorDetail = (input: RouteInput) =>
    Effect.gen(function* monitorRoute() {
      const id = param(input);
      const monitor = yield* deps.monitors.get(id);
      const entry = yield* deps.monitors.activeEntry(id);
      const loaded = yield* Effect.all(
        {
          channels: deps.channels.list(),
          checks: deps.monitors.checks(id, { limit: 50 }),
          incidents: deps.monitors.incidents(id, 20),
          recent: deps.monitors
            .recent(id)
            .pipe(Effect.catchCause(() => Effect.succeed(null))),
          uptime: deps.monitors
            .uptime(id, 90)
            .pipe(Effect.catchCause(() => Effect.succeed(null))),
        },
        { concurrency: "unbounded" }
      );
      return htmlResponse(
        monitorPage({
          ...loaded,
          flash: flashFrom(input.url),
          monitor,
          notChecked: entry.watch.episodeId !== null,
          now: Date.now(),
        })
      );
    });

  const newMonitorForm = () =>
    deps.channels.list().pipe(
      Effect.map((channels) =>
        htmlResponse(
          monitorFormPage({
            channels,
            devMode: deps.devMode,
            error: null,
            monitor: null,
            values: defaultMonitorValues,
          })
        )
      )
    );

  const monitorFormError = (
    input: RouteInput,
    monitor: Pick<MonitorResponse, "id" | "managed" | "name"> | null,
    message: string
  ) =>
    deps.channels.list().pipe(
      Effect.map((channels) =>
        htmlResponse(
          monitorFormPage({
            channels,
            devMode: deps.devMode,
            error: message,
            monitor,
            values: submittedMonitorValues(input.form),
          }),
          400
        )
      )
    );

  const createMonitor = (input: RouteInput) =>
    Effect.gen(function* createMonitorRoute() {
      const parsed = monitorCreateFromForm(input.form);
      if (Result.isFailure(parsed)) {
        return yield* monitorFormError(input, null, parsed.failure);
      }
      return yield* deps.monitors.create(parsed.success).pipe(
        Effect.map((created) =>
          seeOther(`${monitorPath(created.id)}?done=created`)
        ),
        Effect.catchTags({
          BadRequest: (error) => monitorFormError(input, null, error.message),
          Conflict: (error) => monitorFormError(input, null, error.message),
        })
      );
    });

  const editMonitorForm = (input: RouteInput) =>
    Effect.gen(function* editMonitorRoute() {
      const monitor = yield* deps.monitors.get(param(input));
      const channels = yield* deps.channels.list();
      return htmlResponse(
        monitorFormPage({
          channels,
          devMode: deps.devMode,
          error: null,
          monitor,
          values: monitorValues(monitor),
        })
      );
    });

  const updateMonitor = (input: RouteInput) =>
    Effect.gen(function* updateMonitorRoute() {
      const id = param(input);
      const current = yield* deps.monitors.get(id);
      const parsed = monitorPatchFromForm(input.form);
      if (Result.isFailure(parsed)) {
        return yield* monitorFormError(input, current, parsed.failure);
      }
      return yield* deps.monitors.update(id, parsed.success).pipe(
        Effect.map(() => seeOther(`${monitorPath(id)}?done=saved`)),
        Effect.catchTag("BadRequest", (error) =>
          monitorFormError(input, current, error.message)
        )
      );
    });

  /** A one-field change from a detail-page button. */
  const quickUpdate =
    (
      patch: (input: RouteInput) => {
        readonly done: string;
        readonly patch: Parameters<MonitorService["update"]>[1];
      }
    ): Handler =>
    (input) => {
      const id = param(input);
      const change = patch(input);
      return deps.monitors
        .update(id, change.patch)
        .pipe(
          Effect.map(() => seeOther(`${monitorPath(id)}?done=${change.done}`))
        );
    };

  const checkMonitor = (input: RouteInput) => {
    const id = param(input);
    return deps.monitors.check(id).pipe(
      Effect.map(() => seeOther(`${monitorPath(id)}?done=checked`)),
      Effect.catchTag("Conflict", (conflict) =>
        Effect.succeed(errorPage(409, "Cannot check", conflict.message))
      )
    );
  };

  const deleteMonitor = (input: RouteInput) =>
    deps.monitors
      .remove(param(input))
      .pipe(Effect.map(() => seeOther("/?done=deleted")));

  // -- channels -------------------------------------------------------------

  const renderChannels = (data: Omit<ChannelsData, "channels">, status = 200) =>
    deps.channels
      .list()
      .pipe(
        Effect.map((channels) =>
          htmlResponse(channelsPage({ ...data, channels }), status)
        )
      );

  const channelsRoute = (input: RouteInput) =>
    renderChannels({
      flash: flashFrom(input.url),
      formError: null,
      testResult: null,
    });

  const channelFormError = (
    input: RouteInput,
    channelId: string | null,
    message: string
  ) =>
    renderChannels(
      {
        flash: null,
        formError: { channelId, message, values: input.form },
        testResult: null,
      },
      400
    );

  const createChannel = (input: RouteInput) =>
    Effect.gen(function* createChannelRoute() {
      const parsed = channelCreateFromForm(input.form);
      if (Result.isFailure(parsed)) {
        return yield* channelFormError(input, null, parsed.failure);
      }
      return yield* deps.channels.create(parsed.success).pipe(
        Effect.map(() => seeOther("/channels?done=channel-created")),
        Effect.catchTags({
          BadRequest: (error) => channelFormError(input, null, error.message),
          Conflict: (error) => channelFormError(input, null, error.message),
        })
      );
    });

  const updateChannel = (input: RouteInput) =>
    Effect.gen(function* updateChannelRoute() {
      const id = param(input);
      const parsed = channelPatchFromForm(input.form);
      if (Result.isFailure(parsed)) {
        return yield* channelFormError(input, id, parsed.failure);
      }
      return yield* deps.channels.update(id, parsed.success).pipe(
        Effect.map(() => seeOther("/channels?done=channel-saved")),
        Effect.catchTag("BadRequest", (error) =>
          channelFormError(input, id, error.message)
        )
      );
    });

  const testChannel = (input: RouteInput) =>
    Effect.gen(function* testChannelRoute() {
      const id = param(input);
      const result = yield* deps.channels.test(id);
      return yield* renderChannels({
        flash: null,
        formError: null,
        testResult: { channelId: id, result },
      });
    });

  const deleteChannel = (input: RouteInput) =>
    deps.channels
      .remove(param(input))
      .pipe(Effect.map(() => seeOther("/channels?done=channel-deleted")));

  // -- routing --------------------------------------------------------------

  const publicRoutes: readonly Route[] = [
    ["GET", "status", statusRoute],
    ["GET", "login", loginForm],
    ["POST", "login", login],
    ["POST", "logout", logout],
  ];

  const privateRoutes: readonly Route[] = [
    ["GET", "", dashboard],
    ["GET", "monitors/new", newMonitorForm],
    ["POST", "monitors", createMonitor],
    ["GET", "monitors/:id", monitorDetail],
    ["POST", "monitors/:id", updateMonitor],
    ["GET", "monitors/:id/edit", editMonitorForm],
    ["POST", "monitors/:id/check", checkMonitor],
    [
      "POST",
      "monitors/:id/pause",
      quickUpdate(() => ({ done: "paused", patch: { enabled: false } })),
    ],
    [
      "POST",
      "monitors/:id/resume",
      quickUpdate(() => ({ done: "resumed", patch: { enabled: true } })),
    ],
    [
      "POST",
      "monitors/:id/public",
      quickUpdate((input) => {
        const isPublic = input.form.some(
          ([key, value]) => key === "public" && value === "true"
        );
        return {
          done: isPublic ? "public" : "private",
          patch: { public: isPublic },
        };
      }),
    ],
    ["POST", "monitors/:id/delete", deleteMonitor],
    ["GET", "channels", channelsRoute],
    ["POST", "channels", createChannel],
    ["POST", "channels/:id", updateChannel],
    ["POST", "channels/:id/test", testChannel],
    ["POST", "channels/:id/delete", deleteChannel],
  ];

  return Effect.gen(function* uiRoutes() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.originalUrl, "http://internal");
    const segments = url.pathname.split("/").filter(Boolean);
    const isPost = request.method === "POST";

    const open = find(publicRoutes, request.method, segments);
    if (open !== null) {
      return yield* run(
        open.handle,
        { params: open.params, request, url },
        isPost
      );
    }
    const route = find(privateRoutes, request.method, segments);
    const signedIn = yield* hasSession(request);
    if (route === null || !signedIn) {
      // Rejected without running a handler: still drain the body.
      if (isPost) {
        yield* discardRequestBody(request);
      }
      return route === null
        ? htmlResponse(notFoundPage(signedIn), 404)
        : seeOther("/login");
    }
    return yield* run(
      route.handle,
      { params: route.params, request, url },
      isPost
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("page failed", cause).pipe(
        Effect.as(
          errorPage(500, "Something went wrong", "The error has been logged.")
        )
      )
    )
  );
};
