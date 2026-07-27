import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/unstable/http";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";

import type { CheckErrorKind } from "./check-result.ts";
import { CheckResult } from "./check-result.ts";
import { ProbeFailed } from "./errors.ts";
import type { MonitorMethod } from "./monitor.ts";
import type { ValidatedProbeUrl } from "./url.ts";
import { validateProbeUrl } from "./url.ts";

const maxRedirects = 3;
const maxResponseBodyBytes = 1024 * 1024;
const urlValidationTimeoutMs = 5000;

export interface ProbeInput {
  readonly allowHttp: boolean;
  readonly checkId: string;
  readonly expectedStatus: number;
  readonly method: MonitorMethod;
  readonly monitorId: string;
  readonly timeoutMs: number;
  readonly url: string;
}

class TargetProbeError extends Data.TaggedError("TargetProbeError")<{
  readonly kind: CheckErrorKind;
}> {}

interface ProbeSuccess {
  readonly latencyMs: number;
  readonly status: number;
}

const errorMessage = (error: unknown, depth = 0): string => {
  if (depth >= 5) {
    return "";
  }
  if (error instanceof Error) {
    return `${error.message} ${errorMessage(error.cause, depth + 1)}`;
  }
  return typeof error === "string" ? error : "";
};

const classifyHttpError = (error: unknown): CheckErrorKind => {
  const message = errorMessage(error).toLowerCase();
  if (/dns|enotfound|name not resolved|resolve host/u.test(message)) {
    return "dns";
  }
  if (/certificate|handshake|ssl|tls/u.test(message)) {
    return "tls";
  }
  if (/connect|connection|econn|refused|reset/u.test(message)) {
    return "connection";
  }
  return "network";
};

const consumeBoundedBody = Effect.fn("Probe.consumeBoundedBody")(
  function* consumeBoundedBodyEffect(
    response: HttpClientResponse.HttpClientResponse,
    method: MonitorMethod
  ) {
    if (
      method === "HEAD" ||
      response.status === 204 ||
      response.status === 304
    ) {
      return;
    }

    const contentLength = Number(response.headers["content-length"]);
    if (
      Number.isFinite(contentLength) &&
      contentLength > maxResponseBodyBytes
    ) {
      return yield* new TargetProbeError({ kind: "response_too_large" });
    }

    yield* response.stream.pipe(
      Stream.runFoldEffect(
        () => 0,
        (size, chunk) => {
          const nextSize = size + chunk.byteLength;
          return nextSize > maxResponseBodyBytes
            ? Effect.fail(new TargetProbeError({ kind: "response_too_large" }))
            : Effect.succeed(nextSize);
        }
      ),
      Effect.catchIf(
        (error) =>
          HttpClientError.isHttpClientError(error) &&
          error.reason._tag === "EmptyBodyError",
        () => Effect.void
      ),
      Effect.mapError((error) =>
        error instanceof TargetProbeError
          ? error
          : new TargetProbeError({ kind: classifyHttpError(error) })
      )
    );
  }
);

const validateTargetUrl = Effect.fn("Probe.validateTargetUrl")(
  function* validateTargetUrlEffect(
    input: ProbeInput,
    url: string,
    redirect: boolean
  ) {
    const result = yield* validateProbeUrl(url, {
      allowHttp: input.allowHttp,
    }).pipe(Effect.timeoutOption(urlValidationTimeoutMs), Effect.result);

    if (Result.isFailure(result)) {
      if (result.failure.reason === "dns_resolver_failed") {
        return yield* new ProbeFailed({
          cause: result.failure,
          monitorId: input.monitorId,
        });
      }

      const kind: CheckErrorKind =
        result.failure.reason === "dns_lookup_failed" ||
        result.failure.reason === "no_public_address"
          ? "dns"
          : "blocked";

      if (redirect && kind === "blocked") {
        yield* Effect.logWarning("Blocked unsafe probe redirect").pipe(
          Effect.annotateLogs({
            hostname: result.failure.hostname,
            reason: result.failure.reason,
          })
        );
      }

      return yield* new TargetProbeError({ kind });
    }

    if (Option.isNone(result.success)) {
      return yield* new ProbeFailed({
        cause: new Error("URL validation timed out"),
        monitorId: input.monitorId,
      });
    }

    return result.success.value;
  }
);

const timed = Effect.fn("Probe.timed")(function* timedEffect<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  remainingMs: number
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const result = yield* effect.pipe(
    Effect.timeoutOption(Math.max(0, remainingMs))
  );
  const finishedAt = yield* Clock.currentTimeMillis;

  if (Option.isNone(result)) {
    return yield* new TargetProbeError({ kind: "timeout" });
  }

  return {
    elapsedMs: Math.max(0, finishedAt - startedAt),
    value: result.value,
  };
});

const request = Effect.fn("Probe.request")(function* requestEffect(
  input: ProbeInput,
  url: ValidatedProbeUrl,
  redirectCount = 0,
  elapsedMs = 0
): Effect.fn.Return<
  ProbeSuccess,
  ProbeFailed | TargetProbeError,
  HttpClient.HttpClient
> {
  const client = yield* HttpClient.HttpClient;
  const execution = yield* timed(
    HttpClientRequest.make(input.method)(url).pipe(
      client.execute,
      // Security invariant: the Worker runtime must provide FetchHttpClient.layer;
      // FetchHttpClient is what honors this manual redirect setting.
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      // Target URLs can contain sensitive query parameters; do not put the
      // full URL into the HttpClient span attributes.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError(
        (error) => new TargetProbeError({ kind: classifyHttpError(error) })
      )
    ),
    input.timeoutMs - elapsedMs
  );
  const totalElapsedMs = elapsedMs + execution.elapsedMs;
  const response = execution.value;
  const { location } = response.headers;

  if (response.status >= 300 && response.status < 400 && location) {
    if (redirectCount >= maxRedirects) {
      return yield* new TargetProbeError({ kind: "redirect" });
    }

    const nextUrl = yield* Effect.try({
      catch: () => new TargetProbeError({ kind: "redirect" }),
      try: () => new URL(location, url).toString(),
    });
    const validatedUrl = yield* validateTargetUrl(input, nextUrl, true);

    return yield* request(
      input,
      validatedUrl,
      redirectCount + 1,
      totalElapsedMs
    );
  }

  const body = yield* timed(
    consumeBoundedBody(response, input.method),
    input.timeoutMs - totalElapsedMs
  );
  return {
    latencyMs: totalElapsedMs + body.elapsedMs,
    status: response.status,
  };
});

export const probe = Effect.fn("Probe.run")(function* probeEffect(
  input: ProbeInput
) {
  const outcome = yield* validateTargetUrl(input, input.url, false).pipe(
    Effect.flatMap((url) => request(input, url)),
    Effect.map((success) => ({ _tag: "Success" as const, success })),
    Effect.catchTag("TargetProbeError", (failure) =>
      Effect.succeed({ _tag: "Failure" as const, failure })
    )
  );
  const probedAt = yield* Clock.currentTimeMillis;

  if (outcome._tag === "Failure") {
    return new CheckResult({
      checkId: input.checkId,
      errorKind: outcome.failure.kind,
      latencyMs: null,
      ok: false,
      probedAt,
      status: null,
    });
  }

  return new CheckResult({
    checkId: input.checkId,
    errorKind: null,
    latencyMs: outcome.success.latencyMs,
    ok: outcome.success.status === input.expectedStatus,
    probedAt,
    status: outcome.success.status,
  });
});
