import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpEffect from "effect/http/HttpEffect";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";

import {
  clearedSessionCookie,
  createSession,
  sessionCookie,
  sessionCookieName,
  verifySession,
} from "../auth/session.ts";
import { KanshiSettings } from "../settings.ts";
import { requestIsSameOrigin, tokenMatches } from "./auth.ts";
import { KanshiApi } from "./spec.ts";

/** Add `Set-Cookie` (and `no-store`) to the endpoint's response. */
const withCookie = (cookie: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": "no-store",
        "set-cookie": cookie,
      })
    )
  );

const requireSameOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  requestIsSameOrigin(request)
    ? Effect.void
    : Effect.fail(new HttpApiError.Forbidden());

/**
 * `/api/session`: the SPA's sign-in, sign-out and "am I signed in", with
 * the HMAC session cookie (`src/auth/session.ts`).
 */
export const SessionHandlers = HttpApiBuilder.group(
  KanshiApi,
  "session",
  Effect.fnUntraced(function* sessionHandlers(handlers) {
    const { apiToken } = yield* KanshiSettings;
    const token = Redacted.value(apiToken);
    return handlers
      .handle("get", ({ request }) => {
        const value = request.cookies[sessionCookieName];
        const signedIn =
          value === undefined
            ? Effect.succeed(false)
            : Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => verifySession(token, value, now))
              );
        return signedIn.pipe(Effect.map((valid) => ({ signedIn: valid })));
      })
      .handle("signIn", ({ payload, request }) =>
        Effect.gen(function* signIn() {
          yield* requireSameOrigin(request);
          if (
            payload.token.trim() === "" ||
            !tokenMatches(apiToken, payload.token)
          ) {
            yield* Effect.logWarning("dashboard sign-in with a wrong token");
            return yield* new HttpApiError.Unauthorized();
          }
          const now = yield* Clock.currentTimeMillis;
          const session = yield* createSession(token, now);
          yield* withCookie(sessionCookie(session));
        })
      )
      .handle("signOut", ({ request }) =>
        requireSameOrigin(request).pipe(
          Effect.andThen(withCookie(clearedSessionCookie()))
        )
      );
  })
);
