import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

import { isSameOrigin, verifySession } from "../auth/session.ts";
import { ApiAuth, CredentialValidator } from "./middleware.ts";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a cookie-authenticated request passes the CSRF check. */
export const requestIsSameOrigin = (
  request: HttpServerRequest.HttpServerRequest
): boolean =>
  isSameOrigin({
    origin: request.headers.origin,
    secFetchSite: request.headers["sec-fetch-site"],
    url: request.originalUrl,
  });

export const ApiAuthLive = Layer.effect(
  ApiAuth,
  Effect.gen(function* ApiAuthLayer() {
    const validator = yield* CredentialValidator;
    return {
      bearer: (httpEffect, { credential }) =>
        validator
          .validateToken(Redacted.value(credential))
          .pipe(Effect.flatMap(() => httpEffect)),
      session: (httpEffect, { credential }) =>
        Effect.gen(function* sessionAuth() {
          yield* validator.validateSession(Redacted.value(credential));
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (
            !safeMethods.has(request.method) &&
            !requestIsSameOrigin(request)
          ) {
            return yield* new HttpApiError.Forbidden();
          }
          return yield* httpEffect;
        }),
    };
  })
);

const timingSafeEqual = (left: string, right: string): boolean => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  // Cloudflare Workers exposes timingSafeEqual on SubtleCrypto.
  // @ts-expect-error not yet present in the standard TypeScript DOM types
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
};

/** Whether `token` is the API token (timing-safe). */
export const tokenMatches = (
  expected: Redacted.Redacted<string>,
  token: string
): boolean => timingSafeEqual(token.trim(), Redacted.value(expected).trim());

export const credentialValidatorLayer = (expected: Redacted.Redacted<string>) =>
  Layer.succeed(
    CredentialValidator,
    CredentialValidator.of({
      validateSession: (value) =>
        verifySession(Redacted.value(expected), value, Date.now()).pipe(
          Effect.flatMap((valid) =>
            valid ? Effect.void : Effect.fail(new HttpApiError.Unauthorized())
          )
        ),
      validateToken: (token) =>
        tokenMatches(expected, token)
          ? Effect.void
          : Effect.fail(new HttpApiError.Unauthorized()),
    })
  );
