// Integration tests for the dashboard and the public status page: the SPA
// shell (static assets, also for the retired legacy page paths), sign-in
// and cookie auth (`/api/session` and /api), the Origin check on
// cookie-authenticated writes, the dashboard's reads (`/api/overview`,
// `/api/monitors/:id/recent`, `/api/meta`, `/api/watchdog/episodes`,
// `/api/dev/events`), and that GET /api/public/status only ever shows
// monitors that are public right now, without URLs. Run with
// `pnpm test:integ` (it builds the SPA first).
//
// UI rework: every page is the SPA's now (`src/ui/` is unrouted); the
// server-rendered HTML is no longer checked here.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DevEventView,
  Meta,
  MonitorResponse,
  Overview,
} from "../../src/api/spec.ts";
import { ChannelView } from "../../src/domain/channel.ts";
import { RecentActivity } from "../../src/domain/history.ts";
import { minIntervalSeconds } from "../../src/domain/monitor-input.ts";
import { PublicStatus } from "../../src/domain/public-status.ts";
import { Episode } from "../../src/domain/watchdog.ts";
import { apiToken, monitorQuota } from "./alchemy.run.ts";
import { bodyOf, setup, waitFor } from "./harness.ts";

const { create, raw, registryRows, send, stack, test } = setup("integ-ui");

const evilOrigin = "https://evil.example.com";

const origin = stack.pipe(Effect.map(({ url }) => new URL(url).origin));

/** Sign in through `/api/session` and return the `Cookie` header value. */
const signIn = Effect.gen(function* signInEffect() {
  const reply = yield* raw("POST", "/api/session", {
    headers: { origin: yield* origin },
    json: { token: apiToken },
  });
  expect(reply.status).toBe(204);
  const setCookie = reply.headers.get("set-cookie") ?? "";
  const value = /kanshi_session=(?<value>[^;]+)/u.exec(setCookie)?.groups
    ?.value;
  expect(value).toBeDefined();
  return `kanshi_session=${value}`;
});

const publicStatus = send("GET", "/api/public/status", { auth: null }).pipe(
  Effect.flatMap((reply) => {
    expect(reply.status).toBe(200);
    return bodyOf(PublicStatus)(reply);
  })
);

/** The SPA's `index.html`, as the asset layer serves it for `path`. */
const spaShell = (path: string) =>
  raw("GET", path).pipe(
    Effect.map((reply) => {
      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toContain("text/html");
      expect(reply.text).toContain('<div id="root"></div>');
      return reply;
    })
  );

const publicNames = publicStatus.pipe(
  Effect.map((status) => status.monitors.map((monitor) => monitor.name))
);

test(
  "the SPA is served as static assets, with the Worker's paths first",
  Effect.gen(function* spaTest() {
    // The shell for the root, the public status page and any client route.
    const home = yield* spaShell("/");
    const csp = home.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    yield* spaShell("/status");
    yield* spaShell("/some/client/route");

    // Content-hashed files are cached for good.
    const script = /src="(?<path>\/assets\/[^"]+\.js)"/u.exec(home.text)?.groups
      ?.path;
    expect(script).toBeDefined();
    const asset = yield* raw("GET", script ?? "");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");

    // The Worker's own paths never fall back to the shell.
    const unknownApi = yield* raw("GET", "/api/nope");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.text).not.toContain('id="root"');
  }),
  { timeout: 60_000 }
);

test(
  "the retired legacy pages are the SPA's client routes",
  Effect.gen(function* legacyPathsTest() {
    // Signed out or in, the Worker no longer renders or redirects them.
    const cookie = yield* signIn;
    for (const path of [
      "/login",
      "/login?redirect=%2Fchannels",
      "/logout",
      "/monitors",
      "/monitors/new",
      "/monitors/some-id",
      "/monitors/some-id/edit",
      "/channels",
    ]) {
      const shell = yield* spaShell(path);
      expect(shell.text).not.toContain('name="token"');
      const signedIn = yield* raw("GET", path, { headers: { cookie } });
      expect(signedIn.status).toBe(200);
      expect(signedIn.text).toContain('<div id="root"></div>');
    }
    // The old form endpoints are gone: no sign-in, no cookie.
    const post = yield* raw("POST", "/login", {
      form: { token: apiToken },
      headers: { origin: yield* origin },
    });
    expect(post.headers.get("set-cookie")).toBeNull();
    expect(post.headers.get("location")).toBeNull();
  }),
  { timeout: 60_000 }
);

test(
  "/api/session signs in and out with the Origin check",
  Effect.gen(function* sessionTest() {
    const own = yield* origin;
    const state = (cookie?: string) =>
      raw("GET", "/api/session", {
        headers: cookie === undefined ? {} : { cookie },
      }).pipe(Effect.map((reply) => reply.text));

    expect(yield* state()).toBe('{"signedIn":false}');

    const wrong = yield* raw("POST", "/api/session", {
      headers: { origin: own },
      json: { token: "wrong" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const attempts: readonly Readonly<Record<string, string>>[] = [
      { origin: evilOrigin },
      {},
    ];
    for (const headers of attempts) {
      const rejected = yield* raw("POST", "/api/session", {
        headers,
        json: { token: apiToken },
      });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("set-cookie")).toBeNull();
    }

    const ok = yield* raw("POST", "/api/session", {
      headers: { origin: own },
      json: { token: apiToken },
    });
    expect(ok.status).toBe(204);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
    ]) {
      expect(setCookie).toContain(attribute);
    }
    expect(setCookie).not.toContain(apiToken);
    const value = /kanshi_session=(?<value>[^;]+)/u.exec(setCookie)?.groups
      ?.value;
    expect(value).toBeDefined();
    const cookie = `kanshi_session=${value}`;
    expect(yield* state(cookie)).toBe('{"signedIn":true}');
    expect(yield* state(`kanshi_session=1.${"0".repeat(64)}`)).toBe(
      '{"signedIn":false}'
    );
    // The same session as the legacy pages: it works for /api.
    const listed = yield* send("GET", "/api/monitors", {
      auth: null,
      headers: { cookie },
    });
    expect(listed.status).toBe(200);

    const crossSite = yield* raw("DELETE", "/api/session", {
      headers: { cookie, origin: evilOrigin },
    });
    expect(crossSite.status).toBe(403);
    const signedOut = yield* raw("DELETE", "/api/session", {
      headers: { cookie, origin: own },
    });
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
  }),
  { timeout: 60_000 }
);

test(
  "the session cookie works for /api, with the Origin check on writes",
  Effect.gen(function* cookieTest() {
    const own = yield* origin;
    const cookie = yield* signIn;

    // /api accepts the cookie (bearer OR cookie)...
    const listed = yield* send("GET", "/api/monitors", {
      auth: null,
      headers: { cookie },
    });
    expect(listed.status).toBe(200);
    // ...but a cookie-authenticated write must come from our own origin.
    const name = `cookie-${crypto.randomUUID()}`;
    const body = { enabled: false, name, url: "https://example.com" };
    const countNamed = registryRows.pipe(
      Effect.map(
        (rows) => rows.filter((row) => row.summary.name === name).length
      )
    );
    const noOrigin = yield* send("POST", "/api/monitors", {
      auth: null,
      body,
      headers: { cookie },
    });
    expect(noOrigin.status).toBe(403);
    const crossOrigin = yield* send("POST", "/api/monitors", {
      auth: null,
      body,
      headers: { cookie, origin: evilOrigin },
    });
    expect(crossOrigin.status).toBe(403);
    expect(yield* countNamed).toBe(0);
    const sameOrigin = yield* send("POST", "/api/monitors", {
      auth: null,
      body,
      headers: { cookie, origin: own },
    });
    expect(sameOrigin.status).toBe(201);
    const { id } = yield* bodyOf(MonitorResponse)(sameOrigin);
    expect(yield* countNamed).toBe(1);

    const deleteRejected = yield* send("DELETE", `/api/monitors/${id}`, {
      auth: null,
      headers: { cookie, origin: evilOrigin },
    });
    expect(deleteRejected.status).toBe(403);
    expect(yield* countNamed).toBe(1);
    const deleted = yield* send("DELETE", `/api/monitors/${id}`, {
      auth: null,
      headers: { cookie, origin: own },
    });
    expect(deleted.status).toBe(204);
    expect(yield* countNamed).toBe(0);

    // A forged or tampered cookie is worth nothing.
    const forged = "kanshi_session=99999999999999.".concat("0".repeat(64));
    expect(
      (yield* send("GET", "/api/monitors", {
        auth: null,
        headers: { cookie: forged },
      })).status
    ).toBe(401);
  }),
  { timeout: 60_000 }
);

test(
  "making a monitor private removes it from the status page at once",
  Effect.gen(function* privateTest() {
    const cookie = yield* signIn;
    const own = yield* origin;
    const name = `public-${crypto.randomUUID()}`;
    const secret = crypto.randomUUID();
    const { url } = yield* stack;
    const monitor = yield* create({
      intervalSeconds: 5,
      name,
      public: true,
      url: `${url}/_dev/target?secret=${secret}`,
    });

    // Public: listed (and its history cached).
    expect(yield* publicNames).toContain(name);

    // Private via the API: gone on the very next request.
    const patched = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { public: false },
    });
    expect(patched.status).toBe(200);
    expect((yield* bodyOf(MonitorResponse)(patched)).public).toBe(false);
    expect(yield* publicNames).not.toContain(name);

    // Public again via the API, then private as the dashboard does it
    // (the session cookie, from our own origin).
    yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { public: true },
    });
    expect(yield* publicNames).toContain(name);
    const toggled = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      auth: null,
      body: { public: false },
      headers: { cookie, origin: own },
    });
    expect(toggled.status).toBe(200);
    expect(yield* publicNames).not.toContain(name);

    expect((yield* send("DELETE", `/api/monitors/${monitor.id}`)).status).toBe(
      204
    );
  }),
  { timeout: 60_000 }
);

test(
  "the status page shows only public monitors and never their URLs",
  Effect.gen(function* statusTest() {
    const { url } = yield* stack;
    const secret = crypto.randomUUID();
    const shown = yield* create({
      intervalSeconds: 5,
      name: `shown-${secret}`,
      public: true,
      url: `${url}/_dev/target?shown=${secret}`,
    });
    const hidden = yield* create({
      intervalSeconds: 5,
      name: `hidden-${secret}`,
      url: `${url}/_dev/target?hidden=${secret}`,
    });

    const status = yield* publicStatus;
    const names = status.monitors.map((monitor) => monitor.name);
    expect(names).toContain(`shown-${secret}`);
    expect(names).not.toContain(`hidden-${secret}`);
    const json = JSON.stringify(status);
    expect(json).not.toContain("/_dev/target");
    expect(json).not.toContain(`shown=${secret}`);
    expect(json).not.toContain(shown.id);
    for (const item of status.monitors) {
      expect(Object.keys(item).toSorted()).toEqual([
        "days",
        "downSince",
        "lastCheckedAt",
        "name",
        "status",
        "uptimePercent",
      ]);
    }

    for (const monitor of [shown, hidden]) {
      expect(
        (yield* send("DELETE", `/api/monitors/${monitor.id}`)).status
      ).toBe(204);
    }
  }),
  { timeout: 60_000 }
);

/** GET `path` with the token; expects a 200 and decodes the body. */
const read = <S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S
) =>
  send("GET", path).pipe(
    Effect.flatMap((reply) => {
      expect(reply.status).toBe(200);
      return bodyOf(schema)(reply);
    })
  );

const halfHour = 30 * 60_000;

/** The dashboard's reads, each needing the token or the session cookie. */
const dashboardPaths = [
  "/api/overview",
  "/api/meta",
  "/api/watchdog/episodes",
  "/api/dev/events",
];

test(
  "the dashboard's reads need auth; meta, episodes and dev events",
  Effect.gen(function* dashboardAuthTest() {
    const { url } = yield* stack;
    for (const path of [...dashboardPaths, "/api/monitors/some-id/recent"]) {
      expect((yield* send("GET", path, { auth: null })).status).toBe(401);
      expect((yield* send("GET", path, { auth: "wrong" })).status).toBe(401);
    }
    const cookie = yield* signIn;
    for (const path of dashboardPaths) {
      expect((yield* raw("GET", path, { headers: { cookie } })).status).toBe(
        200
      );
    }

    expect(yield* read("/api/meta", Meta)).toEqual({
      devMode: true,
      minIntervalSeconds: minIntervalSeconds(true),
      monitorQuota,
    });
    // Open episodes only (the watchdog tests open one).
    const episodes = yield* read(
      "/api/watchdog/episodes",
      Schema.Array(Episode)
    );
    expect(episodes.every((entry) => entry.resolvedAt === null)).toBe(true);

    // Dev events: the sink's latest requests, newest first.
    const tag = `events-${crypto.randomUUID()}`;
    const channel = yield* send("POST", "/api/channels", {
      body: {
        kind: "webhook",
        name: "events sink",
        url: `${url}/_dev/webhook?tag=${tag}`,
      },
    }).pipe(Effect.flatMap(bodyOf(ChannelView)));
    const tested = yield* send("POST", `/api/channels/${channel.id}/test`);
    expect(tested.body).toMatchObject({ delivered: true });
    const events = yield* read(
      "/api/dev/events?limit=5",
      Schema.Array(DevEventView)
    );
    expect(events.length).toBeLessThanOrEqual(5);
    const ids = events.map((event) => event.id);
    expect(ids).toEqual(ids.toSorted((left, right) => right - left));
    expect(events.find((event) => event.query === `?tag=${tag}`)).toMatchObject(
      { kind: "webhook", respondedWith: 200 }
    );
    expect(
      events.find((event) => event.query === `?tag=${tag}`)?.message
    ).toContain("events sink");
    expect((yield* send("GET", "/api/dev/events?limit=0")).status).toBe(400);
    expect((yield* send("DELETE", `/api/channels/${channel.id}`)).status).toBe(
      204
    );
  }),
  { timeout: 60_000 }
);

test(
  "recent activity and the overview",
  Effect.gen(function* recentTest() {
    const { url } = yield* stack;
    const monitor = yield* create({
      intervalSeconds: 5,
      name: `overview-${crypto.randomUUID()}`,
      url: `${url}/_dev/target`,
    });
    const recentPath = `/api/monitors/${monitor.id}/recent`;

    // 24h in 48 half-hour buckets by default.
    const recent = yield* waitFor(
      "a counted check",
      read(recentPath, RecentActivity),
      (value) => value.counted >= 1
    );
    expect(recent.buckets).toHaveLength(48);
    expect(recent.up).toBe(recent.counted);
    expect(recent.uptimePercent).toBe(100);
    const [first, second] = recent.buckets;
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBe(halfHour);
    expect(recent.buckets.at(-1)?.latencyMs).toBeNumber();
    const hour = yield* read(
      `${recentPath}?hours=1&buckets=12`,
      RecentActivity
    );
    expect(hour.buckets).toHaveLength(12);
    const [hourFirst, hourSecond] = hour.buckets;
    expect((hourSecond?.at ?? 0) - (hourFirst?.at ?? 0)).toBe(5 * 60_000);
    for (const query of ["buckets=0", "buckets=289", "hours=169", "hours=x"]) {
      expect((yield* send("GET", `${recentPath}?${query}`)).status).toBe(400);
    }
    expect((yield* send("GET", "/api/monitors/nope/recent")).status).toBe(404);

    // Every monitor with its flags and recent activity.
    const overview = yield* read("/api/overview", Overview);
    const item = overview.monitors.find((entry) => entry.id === monitor.id);
    expect(item).toMatchObject({
      managed: false,
      name: monitor.name,
      notChecked: false,
      public: false,
    });
    expect(item?.recent?.buckets).toHaveLength(48);
    expect(item?.recent?.counted).toBeGreaterThanOrEqual(1);
    const { down, paused, unknown, up } = overview.counts;
    expect(down + paused + unknown + up).toBe(overview.monitors.length);
    const small = yield* read("/api/overview?hours=2&buckets=4", Overview);
    const smallItem = small.monitors.find((entry) => entry.id === monitor.id);
    expect(smallItem?.recent?.buckets).toHaveLength(4);
    expect((yield* send("GET", "/api/overview?buckets=0")).status).toBe(400);
    const detail = yield* read(`/api/monitors/${monitor.id}`, MonitorResponse);
    expect(detail.notChecked).toBe(false);

    expect((yield* send("DELETE", `/api/monitors/${monitor.id}`)).status).toBe(
      204
    );
    expect((yield* send("GET", recentPath)).status).toBe(404);
  }),
  { timeout: 60_000 }
);
