// Shared TanStack Query options, one per API read. Pages use them with
// `useQuery` / `useSuspenseQuery` and route loaders with
// `queryClient.ensureQueryData`, so each read has one cache key.
import { queryOptions } from "@tanstack/react-query";

import { callApi } from "./client.ts";

/** `GET /api/session`: whether this browser is signed in. */
export const sessionQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.session.get(), signal),
  queryKey: ["session"],
});

/** `GET /api/public/status`: the public status page's data. */
export const publicStatusQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.public.status(), signal),
  queryKey: ["public-status"],
  refetchInterval: 60_000,
});
