import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { requestIsSameOrigin } from "../api/auth.ts";

/**
 * Size limits for request bodies read without auth. Authenticated
 * endpoints decode their payload only after the auth middleware passed;
 * an endpoint without auth would decode whatever a stranger sends, so
 * each one is listed here, capped and Origin-checked before the API sees
 * it.
 */

/** `POST /api/session` carries a JSON token of at most 1024 characters. */
export const signInMaxBytes = 4 * 1024;

interface GuardedBody {
  readonly method: string;
  readonly path: string;
  readonly maxBytes: number;
}

/** Every endpoint without auth that reads a body. */
const guardedBodies: readonly GuardedBody[] = [
  { maxBytes: signInMaxBytes, method: "POST", path: "/api/session" },
];

/** The guard for a request, if its endpoint reads a body without auth. */
export const guardedBodyOf = (
  method: string,
  pathname: string
): GuardedBody | null => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return (
    guardedBodies.find(
      (guard) => guard.method === method && guard.path === path
    ) ?? null
  );
};

interface BodyRead {
  readonly chunks: readonly Uint8Array[];
  readonly size: number;
}

class TooLarge extends Data.TaggedError("TooLarge")<Record<never, never>> {}

const contentLength = (
  request: HttpServerRequest.HttpServerRequest
): number | null => {
  const header = request.headers["content-length"];
  if (header === undefined || !/^\d+$/u.test(header.trim())) {
    return null;
  }
  return Number(header.trim());
};

/**
 * `request` with its body read into memory, or null if the body is larger
 * than `maxBytes`. A declared `content-length` over the limit is refused
 * before anything is read; otherwise (a chunked body) reading stops at
 * the limit. A body that cannot be read passes through as is, for the API
 * to reject.
 */
export const limitBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number
): Effect.Effect<HttpServerRequest.HttpServerRequest | null> => {
  const declared = contentLength(request);
  if (declared !== null) {
    // The runtime never delivers more than the declared length.
    return Effect.succeed(declared > maxBytes ? null : request);
  }
  return request.stream.pipe(
    Stream.runFoldEffect(
      (): BodyRead => ({ chunks: [], size: 0 }),
      (read, chunk) => {
        const size = read.size + chunk.byteLength;
        return size > maxBytes
          ? Effect.fail(new TooLarge())
          : Effect.succeed({ chunks: [...read.chunks, chunk], size });
      }
    ),
    Effect.map(({ chunks, size }) => {
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return HttpServerRequest.fromWeb(
        new Request(request.originalUrl, {
          body,
          headers: request.headers,
          method: request.method,
        })
      ).modify({ remoteAddress: request.remoteAddress });
    }),
    Effect.catchTag("TooLarge", () => Effect.succeed(null)),
    Effect.orElseSucceed(() => request)
  );
};

/**
 * Run `api` for `request`, first applying the guard of an endpoint that
 * reads a body without auth: 403 for another origin (before the body is
 * read), 413 for a body over its limit.
 */
export const guardBody = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  pathname: string,
  api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  Exclude<R, HttpServerRequest.HttpServerRequest>
> =>
  Effect.gen(function* guardBodyEffect() {
    const guard = guardedBodyOf(request.method, pathname);
    if (guard === null) {
      return yield* api.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request)
      );
    }
    if (!requestIsSameOrigin(request)) {
      return HttpServerResponse.empty({ status: 403 });
    }
    const limited = yield* limitBody(request, guard.maxBytes);
    if (limited === null) {
      return HttpServerResponse.empty({ status: 413 });
    }
    return yield* api.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, limited)
    );
  });
