// The route tree (code-based TanStack Router: links, params and search are
// typed without a generated route tree). Page components live in
// `pages/`, one module each exporting only components, so React Fast
// Refresh can hot-swap them; this module only wires routes.
import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";

import { HomePage } from "./pages/home.tsx";
import { NotFound, RootLayout } from "./pages/layout.tsx";
import { StatusPage } from "./pages/status.tsx";

/** What every route's `loader` / `beforeLoad` receives. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const queryClient = new QueryClient();

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

const homeRoute = createRoute({
  component: HomePage,
  getParentRoute: () => rootRoute,
  path: "/",
});

/** Public: no session needed (it reads `/api/public/status`). */
const statusRoute = createRoute({
  component: StatusPage,
  getParentRoute: () => rootRoute,
  path: "/status",
});

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

const routeTree = rootRoute.addChildren([homeRoute, statusRoute, ...devRoutes]);

export const router = createRouter({
  context: { queryClient },
  defaultPreload: "intent",
  // Loaders read through the query cache, which decides freshness.
  defaultPreloadStaleTime: 0,
  routeTree,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
