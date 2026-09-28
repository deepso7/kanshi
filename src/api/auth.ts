/* oxlint-disable eslint/max-classes-per-file -- middleware and its validator are one auth boundary */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

import {
  isSameOrigin,
  sessionCookieName,
  verifySession,
} from "../ui/session.ts";

/** Checks the API token (bearer) and dashboard session cookies. */
export class CredentialValidator extends Context.Service<
  CredentialValidator,
  {
    readonly validateToken: (
      token: string
    ) => Effect.Effect<void, HttpApiError.Unauthorized>;
    readonly validateSession: (
      value: string
    ) => Effect.Effect<void, HttpApiError.Unauthorized>;
  }
>()("kanshi/api/CredentialValidator") {}

/**
 * `/api` auth: the bearer token, or the dashboard's session cookie. A
 * cookie-authenticated request that is not a read must also come from the
 * dashboard's own origin (CSRF), otherwise it is refused with 403.
 */
export class ApiAuth extends HttpApiMiddleware.Service<
  ApiAuth,
  { requires: CredentialValidator }
>()("kanshi/api/ApiAuth", {
  error: [HttpApiError.UnauthorizedNoContent, HttpApiError.ForbiddenNoContent],
  security: {
    bearer: HttpApiSecurity.bearer,
    session: HttpApiSecurity.apiKey({ in: "cookie", key: sessionCookieName }),
  },
}) {}

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
