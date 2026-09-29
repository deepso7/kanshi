import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  clearedSessionCookie,
  isSameOrigin,
  createSession,
  sessionCookie,
  sessionMaxAgeSeconds,
  verifySession,
} from "../../src/auth/session.ts";
import { escapeHtml, html, raw, safeHref } from "../../src/ui/html.ts";

const squash = (markup: string) => markup.replaceAll(/>\s+</gu, "><").trim();

describe(html, () => {
  it("escapes interpolated values", () => {
    const name = `<script>alert("x")</script> & 'y'`;
    assert.strictEqual(
      html`<p title="${name}">${name}</p>`.value,
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>'
    );
    assert.strictEqual(escapeHtml("a&b"), "a&amp;b");
  });

  it("composes templates, arrays and raw markup without re-escaping", () => {
    const items = ["<a>", "b"].map((item) => html`<li>${item}</li>`);
    assert.strictEqual(
      // The formatter re-indents html templates; compare without it.
      squash(
        html`<ul>
            ${items}
          </ul>
          ${raw("<br>")}`.value
      ),
      "<ul><li>&lt;a&gt;</li><li>b</li></ul><br>"
    );
  });

  it("renders false, null and undefined as nothing, numbers as text", () => {
    const show = false;
    assert.strictEqual(
      html`${show && html`<b>no</b>`}${null}${undefined}${0}`.value,
      "0"
    );
  });

  it("only links http(s) URLs", () => {
    assert.strictEqual(
      safeHref("https://example.com/a"),
      "https://example.com/a"
    );
    assert.strictEqual(safeHref(["javascript", "alert(1)"].join(":")), "#");
    assert.strictEqual(safeHref("not a url"), "#");
  });
});

describe("sessions", () => {
  const token = "secret-token";
  const now = 1_700_000_000_000;

  it.effect("verifies a session derived from the token", () =>
    Effect.gen(function* sessionTest() {
      const value = yield* createSession(token, now);
      assert.match(value, /^\d+\.[\da-f]{64}$/u);
      assert.isTrue(yield* verifySession(token, value, now + 1000));
      // Surrounding whitespace in the token is ignored, like the bearer.
      assert.isTrue(yield* verifySession(` ${token}\n`, value, now));
    })
  );

  it.effect("rejects another token, expiry and tampering", () =>
    Effect.gen(function* rejectTest() {
      const value = yield* createSession(token, now);
      // Rotating the token logs everyone out.
      assert.isFalse(yield* verifySession("rotated-token", value, now));
      const expiry = now + sessionMaxAgeSeconds * 1000;
      assert.isFalse(yield* verifySession(token, value, expiry));
      const [expires, signature] = value.split(".");
      assert.isFalse(
        yield* verifySession(token, `${Number(expires) + 1}.${signature}`, now)
      );
      const flipped = `${expires}.${signature?.startsWith("0") ? "1" : "0"}${signature?.slice(1)}`;
      assert.isFalse(yield* verifySession(token, flipped, now));
      for (const bad of ["", "x", `${expires}.`, "1.zz", token]) {
        assert.isFalse(yield* verifySession(token, bad, now), bad);
      }
    })
  );

  it("sets strict, secure, http-only cookies", () => {
    assert.strictEqual(
      sessionCookie("v"),
      `kanshi_session=v; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionMaxAgeSeconds}`
    );
    assert.include(clearedSessionCookie(), "Max-Age=0");
  });
});

describe("origin check", () => {
  const url = "https://kanshi.example.com/login";

  it("accepts the request's own origin", () => {
    assert.isTrue(
      isSameOrigin({
        origin: "https://kanshi.example.com",
        secFetchSite: undefined,
        url,
      })
    );
  });

  it("rejects other origins, schemes, ports and opaque origins", () => {
    for (const origin of [
      "https://evil.example.com",
      "http://kanshi.example.com",
      "https://kanshi.example.com:8443",
      "null",
      "",
    ]) {
      assert.isFalse(
        isSameOrigin({ origin, secFetchSite: "same-origin", url }),
        origin
      );
    }
  });

  it("falls back to Sec-Fetch-Site only without an Origin header", () => {
    assert.isTrue(
      isSameOrigin({ origin: undefined, secFetchSite: "same-origin", url })
    );
    for (const site of ["same-site", "cross-site", "none", undefined]) {
      assert.isFalse(
        isSameOrigin({ origin: undefined, secFetchSite: site, url }),
        site
      );
    }
  });
});
