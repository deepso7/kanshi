import * as Effect from "effect/Effect";

/**
 * Dashboard sessions. The cookie holds `<expiresAt>.<hmac>`, where the HMAC
 * (SHA-256) is keyed by the API token, so no session state is stored and
 * rotating the token logs everyone out.
 */
export const sessionCookieName = "kanshi_session";
export const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

const hmacKey = (token: string) =>
  Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      encoder.encode(`kanshi-session:${token.trim()}`),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign", "verify"]
    )
  );

const payload = (expiresAt: number) =>
  encoder.encode(`kanshi-session:v1:${expiresAt}`);

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^(?:[\da-f]{2})+$/u.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

/** A new session value, valid for `sessionMaxAgeSeconds` from `now`. */
export const createSession = (token: string, now: number) =>
  Effect.gen(function* createSessionEffect() {
    const expiresAt = now + sessionMaxAgeSeconds * 1000;
    const key = yield* hmacKey(token);
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign("HMAC", key, payload(expiresAt))
    );
    return `${expiresAt}.${toHex(signature)}`;
  });

/**
 * Whether `value` is an unexpired session signed with `token`. The
 * signature is checked with `crypto.subtle.verify` (constant time).
 */
export const verifySession = (token: string, value: string, now: number) =>
  Effect.gen(function* verifySessionEffect() {
    const match = /^(?<expires>\d{1,16})\.(?<signature>[\da-f]{64})$/u.exec(
      value.trim()
    );
    const expiresAt = Number(match?.groups?.expires);
    const signature = fromHex(match?.groups?.signature ?? "");
    if (
      signature === null ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    ) {
      return false;
    }
    const key = yield* hmacKey(token);
    return yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, signature, payload(expiresAt))
    );
  });

const cookieAttributes = "Path=/; HttpOnly; Secure; SameSite=Strict";

export const sessionCookie = (value: string): string =>
  `${sessionCookieName}=${value}; ${cookieAttributes}; Max-Age=${sessionMaxAgeSeconds}`;

export const clearedSessionCookie = (): string =>
  `${sessionCookieName}=; ${cookieAttributes}; Max-Age=0`;

export interface OriginInput {
  /** The request's full URL. */
  readonly url: string;
  readonly origin: string | undefined;
  readonly secFetchSite: string | undefined;
}

/**
 * CSRF check for form posts and cookie-authenticated API writes: the
 * `Origin` header must be the request's own origin. Without an `Origin`
 * header, only `Sec-Fetch-Site: same-origin` is accepted.
 */
export const isSameOrigin = (input: OriginInput): boolean => {
  if (!URL.canParse(input.url)) {
    return false;
  }
  const own = new URL(input.url).origin;
  if (input.origin !== undefined) {
    return input.origin === own;
  }
  return input.secFetchSite === "same-origin";
};
