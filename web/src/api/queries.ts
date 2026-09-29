// Shared TanStack Query options, one per API read, and mutation options,
// one per API write. Pages use them with `useQuery` / `useSuspenseQuery` /
// `useMutation` and route loaders with `queryClient.ensureQueryData`, so
// each read has one cache key.
//
// Keys are hierarchical: `["monitors"]` covers every monitor read,
// `["monitors", "detail", id]` one monitor and its checks, uptime,
// incidents and recent activity. A write invalidates what it can change
// (see the `invalidate*` helpers), and waits for it before settling.
import type { QueryClient } from "@tanstack/react-query";
import { mutationOptions, queryOptions } from "@tanstack/react-query";

import type {
  ChannelCreateInput,
  ChannelPatchInput,
} from "../../../src/domain/channel.ts";
import type {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../../../src/domain/monitor-input.ts";
import { callApi } from "./client.ts";

/** `?limit` and `?since` of `GET /api/monitors/:id/checks`. */
export interface ChecksParams {
  readonly limit?: number;
  readonly since?: number;
}

/** `?hours` and `?buckets` of the recent-activity reads. */
export interface RecentParams {
  readonly buckets?: number;
  readonly hours?: number;
}

/** Every query key, in one place. */
export const queryKeys = {
  channels: ["channels"],
  devEvents: (limit?: number) => ["dev-events", { limit }] as const,
  episodes: ["watchdog-episodes"],
  meta: ["meta"],
  monitor: (id: string) => ["monitors", "detail", id] as const,
  monitorChecks: (id: string, params: ChecksParams) =>
    ["monitors", "detail", id, "checks", params] as const,
  monitorIncidents: (id: string, limit?: number) =>
    ["monitors", "detail", id, "incidents", { limit }] as const,
  monitorList: ["monitors", "list"],
  monitorRecent: (id: string, params: RecentParams) =>
    ["monitors", "detail", id, "recent", params] as const,
  monitorUptime: (id: string, days?: number) =>
    ["monitors", "detail", id, "uptime", { days }] as const,
  monitors: ["monitors"],
  overview: (params: RecentParams) => ["overview", params] as const,
  publicStatus: ["public-status"],
  session: ["session"],
} as const;

// -- session -----------------------------------------------------------------

/** `GET /api/session`: whether this browser is signed in. */
export const sessionQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.session.get(), signal),
  queryKey: queryKeys.session,
});

/**
 * `POST /api/session`: sign in with the API token (401 if wrong). A 204
 * means signed in: the session read is set, not refetched, so the route
 * guard (`ensureQueryData(sessionQuery)`) sees it at once.
 */
export const signInMutation = mutationOptions({
  mutationFn: (token: string) =>
    callApi((api) => api.session.signIn({ payload: { token } })),
  mutationKey: ["session", "sign-in"],
  onSuccess: (_data, _token, _result, { client }) => {
    client.setQueryData(sessionQuery.queryKey, { signedIn: true });
  },
});

/** `DELETE /api/session`: sign out; drops every cached read. */
export const signOutMutation = mutationOptions({
  mutationFn: () => callApi((api) => api.session.signOut()),
  mutationKey: ["session", "sign-out"],
  onSuccess: (_data, _variables, _result, { client }) => {
    client.clear();
  },
});

// -- reads -------------------------------------------------------------------

/**
 * The windows the monitor page reads (the route loader prefetches exactly
 * these, so the page must pass the same values to share the cache).
 */
export const monitorPageReads = {
  checks: { limit: 50 },
  incidentsLimit: 20,
} as const satisfies { checks: ChecksParams; incidentsLimit: number };

/** `GET /api/meta`: dev mode, the minimum interval and the monitor quota. */
export const metaQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.meta.get(), signal),
  queryKey: queryKeys.meta,
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * `GET /api/overview`: the dashboard in one call (every monitor, its
 * status counts and recent activity; 24h in 48 buckets by default).
 */
export const overviewQuery = (params: RecentParams = {}) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi((api) => api.overview.get({ query: params }), signal),
    queryKey: queryKeys.overview(params),
    refetchInterval: 30_000,
  });

/** `GET /api/monitors`: every monitor's cached summary. */
export const monitorListQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.monitors.list(), signal),
  queryKey: queryKeys.monitorList,
});

/** `GET /api/monitors/:id`: configuration, flags and state. */
export const monitorQuery = (id: string) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi((api) => api.monitors.get({ params: { id } }), signal),
    queryKey: queryKeys.monitor(id),
  });

/** `GET /api/monitors/:id/checks`: newest first (100 by default). */
export const monitorChecksQuery = (id: string, params: ChecksParams = {}) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi(
        (api) => api.monitors.checks({ params: { id }, query: params }),
        signal
      ),
    queryKey: queryKeys.monitorChecks(id, params),
  });

/** `GET /api/monitors/:id/uptime`: daily uptime (90 days by default). */
export const monitorUptimeQuery = (id: string, days?: number) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi(
        (api) =>
          api.monitors.uptime({
            params: { id },
            query: days === undefined ? {} : { days },
          }),
        signal
      ),
    queryKey: queryKeys.monitorUptime(id, days),
  });

/** `GET /api/monitors/:id/incidents`: newest first, with alert rows. */
export const monitorIncidentsQuery = (id: string, limit?: number) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi(
        (api) =>
          api.monitors.incidents({
            params: { id },
            query: limit === undefined ? {} : { limit },
          }),
        signal
      ),
    queryKey: queryKeys.monitorIncidents(id, limit),
  });

/** `GET /api/monitors/:id/recent`: uptime and latency buckets (24h/48). */
export const monitorRecentQuery = (id: string, params: RecentParams = {}) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi(
        (api) => api.monitors.recent({ params: { id }, query: params }),
        signal
      ),
    queryKey: queryKeys.monitorRecent(id, params),
  });

/** `GET /api/channels`: every alert channel (URLs masked). */
export const channelsQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.channels.list(), signal),
  queryKey: queryKeys.channels,
});

/** `GET /api/watchdog/episodes`: open "not being checked" episodes. */
export const episodesQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.watchdog.episodes(), signal),
  queryKey: queryKeys.episodes,
  refetchInterval: 30_000,
});

/**
 * `GET /api/dev/events`: the dev webhook sink, newest first (20 by
 * default). Dev mode only (404 otherwise): enable it from `metaQuery`.
 */
export const devEventsQuery = (limit?: number) =>
  queryOptions({
    queryFn: ({ signal }) =>
      callApi(
        (api) =>
          api.dev.events({ query: limit === undefined ? {} : { limit } }),
        signal
      ),
    queryKey: queryKeys.devEvents(limit),
    refetchInterval: 10_000,
  });

/** `GET /api/public/status`: the public status page's data. */
export const publicStatusQuery = queryOptions({
  queryFn: ({ signal }) => callApi((api) => api.public.status(), signal),
  queryKey: queryKeys.publicStatus,
  refetchInterval: 60_000,
});

// -- invalidation ------------------------------------------------------------

/**
 * After a monitor write: the list, the overview, the watchdog episodes and
 * the public status, plus one monitor's reads (`id`) or all of them.
 */
export const invalidateMonitors = (client: QueryClient, id?: string) =>
  Promise.all([
    client.invalidateQueries({
      queryKey: id === undefined ? queryKeys.monitors : queryKeys.monitor(id),
    }),
    client.invalidateQueries({ queryKey: queryKeys.monitorList }),
    client.invalidateQueries({ queryKey: ["overview"] }),
    client.invalidateQueries({ queryKey: queryKeys.episodes }),
    client.invalidateQueries({ queryKey: queryKeys.publicStatus }),
  ]);

/** After a channel write: the channel list (monitor pages name channels). */
export const invalidateChannels = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: queryKeys.channels });

// -- monitor writes ----------------------------------------------------------

/** `POST /api/monitors` (400 invalid, 409 key taken or quota reached). */
export const createMonitorMutation = mutationOptions({
  mutationFn: (payload: MonitorCreateInput) =>
    callApi((api) => api.monitors.create({ payload })),
  mutationKey: ["monitors", "create"],
  onSuccess: (monitor, _payload, _result, { client }) => {
    client.setQueryData(queryKeys.monitor(monitor.id), monitor);
    return invalidateMonitors(client);
  },
});

/** A monitor patch: also pause/resume (`enabled`) and `public`. */
export interface MonitorUpdate {
  readonly id: string;
  readonly patch: MonitorPatchInput;
}

/** `PATCH /api/monitors/:id` (400, 404, 409, 503: see the API). */
export const updateMonitorMutation = mutationOptions({
  mutationFn: ({ id, patch }: MonitorUpdate) =>
    callApi((api) => api.monitors.update({ params: { id }, payload: patch })),
  mutationKey: ["monitors", "update"],
  onSettled: (_monitor, _error, { id }, _result, { client }) =>
    invalidateMonitors(client, id),
  onSuccess: (monitor, { id }, _result, { client }) => {
    client.setQueryData(queryKeys.monitor(id), monitor);
  },
});

/** `DELETE /api/monitors/:id`: drops its cached reads. */
export const deleteMonitorMutation = mutationOptions({
  mutationFn: (id: string) =>
    callApi((api) => api.monitors.remove({ params: { id } })),
  mutationKey: ["monitors", "delete"],
  onSuccess: (_data, id, _result, { client }) => {
    client.removeQueries({ queryKey: queryKeys.monitor(id) });
    return invalidateMonitors(client);
  },
});

/** `POST /api/monitors/:id/check`: check now (409 while disabled). */
export const checkMonitorMutation = mutationOptions({
  mutationFn: (id: string) =>
    callApi((api) => api.monitors.check({ params: { id } })),
  mutationKey: ["monitors", "check"],
  onSuccess: (monitor, id, _result, { client }) => {
    client.setQueryData(queryKeys.monitor(id), monitor);
    return invalidateMonitors(client, id);
  },
});

// -- channel writes ----------------------------------------------------------

/** `POST /api/channels` (400 invalid URL, 409 key taken). */
export const createChannelMutation = mutationOptions({
  mutationFn: (payload: ChannelCreateInput) =>
    callApi((api) => api.channels.create({ payload })),
  mutationKey: ["channels", "create"],
  onSuccess: (_channel, _payload, _result, { client }) =>
    invalidateChannels(client),
});

/** A channel patch; a new `url` replaces the secret. */
export interface ChannelUpdate {
  readonly id: string;
  readonly patch: ChannelPatchInput;
}

/** `PATCH /api/channels/:id`. */
export const updateChannelMutation = mutationOptions({
  mutationFn: ({ id, patch }: ChannelUpdate) =>
    callApi((api) => api.channels.update({ params: { id }, payload: patch })),
  mutationKey: ["channels", "update"],
  onSuccess: (_channel, _update, _result, { client }) =>
    invalidateChannels(client),
});

/** `DELETE /api/channels/:id`: monitors stop alerting it. */
export const deleteChannelMutation = mutationOptions({
  mutationFn: (id: string) =>
    callApi((api) => api.channels.remove({ params: { id } })),
  mutationKey: ["channels", "delete"],
  onSuccess: (_data, _id, _result, { client }) =>
    Promise.all([invalidateChannels(client), invalidateMonitors(client)]),
});

/**
 * `POST /api/channels/:id/test`: send a test alert. Resolves with
 * `{ delivered, status, error }` whether or not the channel accepted it.
 */
export const testChannelMutation = mutationOptions({
  mutationFn: (id: string) =>
    callApi((api) => api.channels.test({ params: { id } })),
  mutationKey: ["channels", "test"],
});
