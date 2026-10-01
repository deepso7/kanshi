// The route tree (code-based TanStack Router: links, params and search are
// typed without a generated route tree). Page components live in
// `pages/`, one module each exporting only components, so React Fast
// Refresh can hot-swap them; this module only wires routes: guards,
// loaders (which warm the query cache) and search validation.
//
//   /                          public: the status page; no app shell
//   /manage/login              public; `?redirect=` back after signing in
//   _app (layout)              the session guard and the app shell
//     /manage                  dashboard
//     /manage/monitors/new
//     /manage/monitors/$id
//     /manage/monitors/$id/edit
//     /manage/channels
//   /_ui                       dev only: the design-system showcase
//   anything else              the root's not-found page
import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  redirect,
} from "@tanstack/react-router";
import * as Predicate from "effect/Predicate";

import { isNotFound, isUnauthorized, shouldRetry } from "./api/errors.ts";
import {
  channelsQuery,
  devEventsQuery,
  episodesQuery,
  metaQuery,
  monitorChecksQuery,
  monitorIncidentsQuery,
  monitorPageReads,
  monitorQuery,
  monitorRecentQuery,
  monitorUptimeQuery,
  overviewQuery,
  publicStatusQuery,
  sessionQuery,
} from "./api/queries.ts";
import { isSafeRedirect, redirectTarget } from "./lib/redirect.ts";
import {
  AppLayout,
  NotFoundPanel,
  RootLayout,
  RouteError,
  RoutePending,
  StandalonePending,
  StandaloneRouteError,
  StatusPending,
} from "./pages/layout.tsx";
import { NotFoundPage } from "./pages/not-found.tsx";

// Each page is its own chunk, fetched alongside its route's loader (and on
// hover, with `defaultPreload: "intent"`); the shell stays in the entry.
const LoginPage = lazyRouteComponent(
  () => import("./pages/login.tsx"),
  "LoginPage"
);
const StatusPage = lazyRouteComponent(
  () => import("./pages/status.tsx"),
  "StatusPage"
);
const DashboardPage = lazyRouteComponent(
  () => import("./pages/dashboard.tsx"),
  "DashboardPage"
);
const MonitorDetailPage = lazyRouteComponent(
  () => import("./pages/monitor-detail.tsx"),
  "MonitorDetailPage"
);
const NewMonitorPage = lazyRouteComponent(
  () => import("./pages/monitor-form.tsx"),
  "NewMonitorPage"
);
const EditMonitorPage = lazyRouteComponent(
  () => import("./pages/monitor-form.tsx"),
  "EditMonitorPage"
);
const ChannelsPage = lazyRouteComponent(
  () => import("./pages/channels.tsx"),
  "ChannelsPage"
);

/** What every route's `loader` / `beforeLoad` receives. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetry } },
});

/** A loader's read that 404s renders the route's not-found component. */
const orNotFound = async <A,>(read: Promise<A>): Promise<A> => {
  try {
    return await read;
  } catch (error) {
    if (error instanceof Error && isNotFound(error)) {
      throw notFound();
    }
    throw error;
  }
};

/** The dev webhook sink's panel, in dev mode only. */
const prefetchDevEvents = async (client: QueryClient) => {
  const meta = await client.ensureQueryData(metaQuery);
  if (meta.devMode) {
    await client.prefetchQuery(devEventsQuery());
  }
};

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: StandaloneRouteError,
  notFoundComponent: NotFoundPage,
});

// -- public ------------------------------------------------------------------

/** `?redirect=`: a same-site path to return to after signing in. */
export interface LoginSearch {
  redirect?: string | undefined;
}

const loginRoute = createRoute({
  beforeLoad: async ({ context: { queryClient: client }, search }) => {
    const session = await client.ensureQueryData(sessionQuery);
    if (session.signedIn) {
      throw redirect({ href: redirectTarget(search.redirect), replace: true });
    }
  },
  component: LoginPage,
  errorComponent: StandaloneRouteError,
  getParentRoute: () => rootRoute,
  path: "/manage/login",
  pendingComponent: StandalonePending,
  validateSearch: (search: { readonly redirect?: unknown }): LoginSearch => {
    const target = search.redirect;
    return {
      redirect:
        Predicate.isString(target) && isSafeRedirect(target)
          ? target
          : undefined,
    };
  },
});

/** Public, at the root: no session needed (it reads `/api/public/status`). */
const statusRoute = createRoute({
  component: StatusPage,
  // Its own frame, not the app shell's.
  errorComponent: StandaloneRouteError,
  getParentRoute: () => rootRoute,
  loader: ({ context: { queryClient: client } }) =>
    client.ensureQueryData(publicStatusQuery),
  path: "/",
  pendingComponent: StatusPending,
});

// -- signed in ---------------------------------------------------------------

/** The session guard and the app shell around every private page. */
const appRoute = createRoute({
  beforeLoad: async ({ context: { queryClient: client }, location }) => {
    const session = await client.ensureQueryData(sessionQuery);
    if (!session.signedIn) {
      throw redirect({
        search: { redirect: location.href },
        to: "/manage/login",
      });
    }
    // The shell's dev badge; forms read the minimum interval from it.
    void client.prefetchQuery(metaQuery);
  },
  component: AppLayout,
  errorComponent: StandaloneRouteError,
  getParentRoute: () => rootRoute,
  id: "_app",
  pendingComponent: StandalonePending,
});

const dashboardRoute = createRoute({
  component: DashboardPage,
  getParentRoute: () => appRoute,
  loader: async ({ context: { queryClient: client } }) => {
    void client.prefetchQuery(episodesQuery);
    void prefetchDevEvents(client);
    await client.ensureQueryData(overviewQuery());
  },
  path: "/manage",
});

const newMonitorRoute = createRoute({
  component: NewMonitorPage,
  getParentRoute: () => appRoute,
  loader: async ({ context: { queryClient: client } }) => {
    await Promise.all([
      client.ensureQueryData(channelsQuery),
      client.ensureQueryData(metaQuery),
    ]);
  },
  path: "/manage/monitors/new",
});

const monitorRoute = createRoute({
  component: MonitorDetailPage,
  getParentRoute: () => appRoute,
  loader: async ({ context: { queryClient: client }, params: { id } }) => {
    // Sections load on their own (skeletons); the monitor itself gates the
    // page, and a 404 shows the not-found panel.
    void client.prefetchQuery(monitorRecentQuery(id));
    void client.prefetchQuery(monitorUptimeQuery(id));
    void client.prefetchQuery(monitorChecksQuery(id, monitorPageReads.checks));
    void client.prefetchQuery(
      monitorIncidentsQuery(id, monitorPageReads.incidentsLimit)
    );
    void client.prefetchQuery(channelsQuery);
    await orNotFound(client.ensureQueryData(monitorQuery(id)));
  },
  // Set here: a loader's `notFound()` skips the router's default.
  notFoundComponent: NotFoundPanel,
  path: "/manage/monitors/$id",
});

const editMonitorRoute = createRoute({
  component: EditMonitorPage,
  getParentRoute: () => appRoute,
  loader: async ({ context: { queryClient: client }, params: { id } }) => {
    await Promise.all([
      orNotFound(client.ensureQueryData(monitorQuery(id))),
      client.ensureQueryData(channelsQuery),
      client.ensureQueryData(metaQuery),
    ]);
  },
  notFoundComponent: NotFoundPanel,
  path: "/manage/monitors/$id/edit",
});

const channelsRoute = createRoute({
  component: ChannelsPage,
  getParentRoute: () => appRoute,
  loader: async ({ context: { queryClient: client } }) => {
    // Meta: dev mode decides which URLs the forms accept.
    await Promise.all([
      client.ensureQueryData(channelsQuery),
      client.ensureQueryData(metaQuery),
    ]);
  },
  path: "/manage/channels",
});

// -- dev ---------------------------------------------------------------------

/**
 * Dev only: the design-system showcase. The dynamic import sits behind
 * `import.meta.env.DEV`, so production builds drop the page entirely.
 */
const devRoutes = import.meta.env.DEV
  ? [
      createRoute({
        component: lazyRouteComponent(
          () => import("./pages/ui-showcase.tsx"),
          "UiShowcase"
        ),
        getParentRoute: () => rootRoute,
        path: "/_ui",
      }),
    ]
  : [];

const routeTree = rootRoute.addChildren([
  loginRoute,
  statusRoute,
  appRoute.addChildren([
    dashboardRoute,
    newMonitorRoute,
    monitorRoute,
    editMonitorRoute,
    channelsRoute,
  ]),
  ...devRoutes,
]);

export const router = createRouter({
  context: { queryClient },
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFoundPanel,
  defaultPendingComponent: RoutePending,
  // Skeletons only when a loader is slow, and then long enough to read.
  defaultPendingMinMs: 300,
  defaultPendingMs: 250,
  defaultPreload: "intent",
  // Loaders read through the query cache, which decides freshness.
  defaultPreloadStaleTime: 0,
  routeTree,
  scrollRestoration: true,
});

/**
 * Any API call answering 401 (the session expired or was revoked): mark
 * the session signed out and show the login page, then come back here. The login
 * page's own 401 (a wrong token) stays on it. Registered on both caches
 * below, for every query and mutation.
 */
const signOutOnUnauthorized = (error: Error) => {
  if (!isUnauthorized(error)) {
    return;
  }
  // Set, not removed: removing would cancel the login guard's own
  // session fetch when several reads fail with 401 at once.
  queryClient.setQueryData(sessionQuery.queryKey, { signedIn: false });
  const { href, pathname } = router.state.location;
  if (pathname !== "/manage/login") {
    void router.navigate({
      replace: true,
      search: { redirect: href },
      to: "/manage/login",
    });
  }
};

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    signOutOnUnauthorized(event.action.error);
  }
});
queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    signOutOnUnauthorized(event.action.error);
  }
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
