// The typed `/api` client, derived from the Worker's `HttpApi` spec: the
// same schemas encode requests and decode replies on both sides. Requests
// are same-origin, so the browser sends the session cookie itself.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { KanshiApi } from "../../../src/api/spec.ts";

export class ApiClient extends Context.Service<
  ApiClient,
  HttpApiClient.ForApi<typeof KanshiApi>
>()("kanshi/web/ApiClient") {
  static readonly layer = Layer.effect(
    ApiClient,
    HttpApiClient.make(KanshiApi, { baseUrl: globalThis.location.origin })
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

/** One runtime for the page's lifetime; the client is built once. */
const runtime = ManagedRuntime.make(ApiClient.layer);

/**
 * Run one API call, for a TanStack Query `queryFn` / `mutationFn`. The
 * promise rejects with the typed error (e.g. `NotFound`, or
 * `HttpApiError.Unauthorized`); `signal` cancels the request.
 *
 * ```ts
 * queryOptions({
 *   queryKey: ["monitors"],
 *   queryFn: ({ signal }) => callApi((api) => api.monitors.list(), signal),
 * })
 * ```
 */
export const callApi = <A, E>(
  call: (api: ApiClient["Service"]) => Effect.Effect<A, E>,
  signal?: AbortSignal
): Promise<A> =>
  runtime.runPromise(
    Effect.gen(function* apiCall() {
      return yield* call(yield* ApiClient);
    }),
    { signal }
  );
