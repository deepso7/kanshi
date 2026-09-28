// Integration tests for the dashboard and the public status page: sign-in
// and cookie auth (pages and /api), the Origin check on form posts, and
// that the status page and GET /api/public/status only ever show monitors
// that are public right now, without URLs. Run with `pnpm test:integ`.
import { expect } from "bun:test";

import * as Effect from "effect/Effect";

import type { PublicStatus } from "../../src/domain/public-status.ts";
import { apiToken } from "./alchemy.run.ts";
import { setup } from "./harness.ts";

const { create, raw, registryRows, send, stack, test } = setup("integ-ui");

const evilOrigin = "https://evil.example.com";

const origin = stack.pipe(Effect.map(({ url }) => new URL(url).origin));

/** Sign in through the form and return the `Cookie` header value. */
const signIn = Effect.gen(function* signInEffect() {
  const reply = yield* raw("POST", "/login", {
    form: { token: apiToken },
    headers: { origin: yield* origin },
  });
  expect(reply.status).toBe(303);
  const setCookie = reply.headers.get("set-cookie") ?? "";
  const value = /kanshi_session=(?<value>[^;]+)/u.exec(setCookie)?.groups
    ?.value;
  expect(value).toBeDefined();
  return `kanshi_session=${value}`;
});

const publicStatus = send("GET", "/api/public/status", { auth: null }).pipe(
  Effect.map((reply) => {
    expect(reply.status).toBe(200);
    return reply.body as PublicStatus;
  })
);

const statusHtml = raw("GET", "/status").pipe(
  Effect.map((reply) => {
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    return reply.text;
  })
);

const publicNames = publicStatus.pipe(
  Effect.map((status) => status.monitors.map((monitor) => monitor.name))
);

test(
  "sign-in sets a strict session cookie that works for pages and /api",
  Effect.gen(function* loginTest() {
    const own = yield* origin;

    // Signed-out pages redirect to the login form.
    const home = yield* raw("GET", "/");
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/login");
    const login = yield* raw("GET", "/login");
    expect(login.status).toBe(200);
    expect(login.text).toContain('name="token"');

    const wrong = yield* raw("POST", "/login", {
      form: { token: "wrong" },
      headers: { origin: own },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const crossSite = yield* raw("POST", "/login", {
      form: { token: apiToken },
      headers: { origin: evilOrigin },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("set-cookie")).toBeNull();

    const ok = yield* raw("POST", "/login", {
      form: { token: apiToken },
      headers: { origin: own },
    });
    expect(ok.status).toBe(303);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
    ]) {
      expect(setCookie).toContain(attribute);
    }
    // The cookie is derived from, not equal to, the token.
    expect(setCookie).not.toContain(apiToken);

    const cookie = yield* signIn;
    const dashboard = yield* raw("GET", "/", { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain("<h1>Monitors</h1>");
    for (const path of ["/monitors/new", "/channels"]) {
      expect((yield* raw("GET", path, { headers: { cookie } })).status).toBe(
        200
      );
    }

    // /api accepts the cookie (bearer OR cookie)...
    const listed = yield* send("GET", "/api/monitors", {
      auth: null,
      headers: { cookie },
    });
    expect(listed.status).toBe(200);
    // ...but a cookie-authenticated write must come from our own origin.
    const body = { enabled: false, name: "cookie", url: "https://example.com" };
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
    const sameOrigin = yield* send("POST", "/api/monitors", {
      auth: null,
      body,
      headers: { cookie, origin: own },
    });
    expect(sameOrigin.status).toBe(201);
    const { id } = sameOrigin.body as { readonly id: string };
    expect((yield* send("DELETE", `/api/monitors/${id}`)).status).toBe(204);

    // A forged or tampered cookie is worth nothing.
    const forged = "kanshi_session=99999999999999.".concat("0".repeat(64));
    expect(
      (yield* raw("GET", "/", { headers: { cookie: forged } })).status
    ).toBe(303);
    expect(
      (yield* send("GET", "/api/monitors", {
        auth: null,
        headers: { cookie: forged },
      })).status
    ).toBe(401);

    // Sign-out clears the cookie.
    const logout = yield* raw("POST", "/logout", {
      headers: { cookie, origin: own },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  }),
  { timeout: 60_000 }
);

test(
  "form posts with a bad or missing Origin are rejected",
  Effect.gen(function* originTest() {
    const cookie = yield* signIn;
    const own = yield* origin;
    const name = `origin-${crypto.randomUUID()}`;
    const form = {
      channelMode: "all",
      intervalSeconds: "60",
      name,
      timeoutSeconds: "10",
      url: "https://example.com/",
    };
    const countNamed = registryRows.pipe(
      Effect.map(
        (rows) => rows.filter((row) => row.summary.name === name).length
      )
    );

    const attempts: readonly Readonly<Record<string, string>>[] = [
      { cookie, origin: evilOrigin },
      { cookie },
    ];
    for (const headers of attempts) {
      const rejected = yield* raw("POST", "/monitors", { form, headers });
      expect(rejected.status).toBe(403);
    }
    expect(yield* countNamed).toBe(0);

    const created = yield* raw("POST", "/monitors", {
      form,
      headers: { cookie, origin: own },
    });
    expect(created.status).toBe(303);
    const location = created.headers.get("location") ?? "";
    expect(location).toMatch(/^\/monitors\/[\da-f-]+\?done=created$/u);
    expect(yield* countNamed).toBe(1);
    const path = location.split("?")[0] ?? "";

    const page = yield* raw("GET", path, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.text).toContain(name);

    const deleteRejected = yield* raw("POST", `${path}/delete`, {
      headers: { cookie, origin: evilOrigin },
    });
    expect(deleteRejected.status).toBe(403);
    expect(yield* countNamed).toBe(1);

    const deleted = yield* raw("POST", `${path}/delete`, {
      headers: { cookie, origin: own },
    });
    expect(deleted.status).toBe(303);
    expect(yield* countNamed).toBe(0);
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

    // Public: listed (and its history cached) on both.
    expect(yield* publicNames).toContain(name);
    expect(yield* statusHtml).toContain(name);

    // Private via the API: gone from both on the very next request.
    const patched = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { public: false },
    });
    expect(patched.status).toBe(200);
    expect((patched.body as { readonly public: boolean }).public).toBe(false);
    expect(yield* publicNames).not.toContain(name);
    expect(yield* statusHtml).not.toContain(name);

    // Public again via the API, then private via the dashboard button.
    yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { public: true },
    });
    expect(yield* publicNames).toContain(name);
    const button = yield* raw("POST", `/monitors/${monitor.id}/public`, {
      form: { public: "false" },
      headers: { cookie, origin: own },
    });
    expect(button.status).toBe(303);
    expect(yield* publicNames).not.toContain(name);
    expect(yield* statusHtml).not.toContain(name);

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

    const html = yield* statusHtml;
    expect(html).toContain(`shown-${secret}`);
    expect(html).not.toContain(`hidden-${secret}`);
    expect(html).not.toContain("/_dev/target");
    expect(html).not.toContain(`shown=${secret}`);
    expect(html).not.toContain(shown.id);

    for (const monitor of [shown, hidden]) {
      expect(
        (yield* send("DELETE", `/api/monitors/${monitor.id}`)).status
      ).toBe(204);
    }
  }),
  { timeout: 60_000 }
);
