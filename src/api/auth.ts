/* oxlint-disable eslint/max-classes-per-file -- middleware and its validator are one auth boundary */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

export class BearerTokenValidator extends Context.Service<
  BearerTokenValidator,
  {
    readonly validate: (
      token: string
    ) => Effect.Effect<void, HttpApiError.Unauthorized>;
  }
>()("kanshi/api/BearerTokenValidator") {}

export class ApiAuth extends HttpApiMiddleware.Service<
  ApiAuth,
  { requires: BearerTokenValidator }
>()("kanshi/api/ApiAuth", {
  error: HttpApiError.UnauthorizedNoContent,
  security: {
    bearer: HttpApiSecurity.bearer,
  },
}) {}

export const ApiAuthLive = Layer.effect(
  ApiAuth,
  Effect.gen(function* ApiAuthLayer() {
    const validator = yield* BearerTokenValidator;
    return {
      bearer: (httpEffect, { credential }) =>
        validator
          .validate(Redacted.value(credential))
          .pipe(Effect.flatMap(() => httpEffect)),
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

export const bearerTokenValidatorLayer = (
  expected: Redacted.Redacted<string>
) =>
  Layer.succeed(
    BearerTokenValidator,
    BearerTokenValidator.of({
      validate: (token) =>
        timingSafeEqual(token.trim(), Redacted.value(expected).trim())
          ? Effect.void
          : Effect.fail(new HttpApiError.Unauthorized()),
    })
  );
