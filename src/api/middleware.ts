/* oxlint-disable eslint/max-classes-per-file -- the middleware and the service it requires are one declaration */
// The `/api` auth middleware as the spec declares it. Browser-safe: the
// SPA's `HttpApiClient` imports the spec, so this module must not import
// Worker-only code. The implementation is `ApiAuthLive` in `./auth.ts`.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";

import { sessionCookieName } from "../auth/session.ts";

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
