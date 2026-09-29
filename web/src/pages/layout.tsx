// The layouts every route renders in, and the router's default pending,
// error and not-found components.
import * as stylex from "@stylexjs/stylex";
import { useQuery, useQueryErrorResetBoundary } from "@tanstack/react-query";
import type { ErrorComponentProps } from "@tanstack/react-router";
import {
  Link,
  Outlet,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";

import { metaQuery, signOutMutation } from "../api/queries.ts";
import { AppShell, AppShellNavLink } from "../components/app-shell.tsx";
import { CenteredScreen } from "../components/centered-screen.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { ErrorPanel } from "../components/error-panel.tsx";
import { PageSkeleton } from "../components/page-skeleton.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button, buttonStyles } from "../components/ui/button.tsx";
import { shared } from "../components/ui/shared.ts";
import { useToastMutation } from "../lib/use-toast-mutation.ts";
import {
  colors,
  fontSizes,
  fonts,
  lineHeights,
} from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  app: {
    color: colors.foreground,
    fontFamily: fonts.sans,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    minHeight: "100dvh",
  },
  external: {
    fontFamily: fonts.mono,
    marginLeft: "auto",
    opacity: 0.7,
  },
  standalone: {
    maxWidth: "36rem",
    width: "100%",
  },
});

/** The root: fonts and colors; each layout below owns its frame. */
export const RootLayout = () => (
  <div {...stylex.props(styles.app)}>
    <Outlet />
  </div>
);

/** Monitor pages belong to the dashboard's section of the nav. */
const isDashboardPath = (pathname: string) =>
  pathname === "/" || pathname.startsWith("/monitors");

/**
 * The signed-in layout: the app shell with the nav, the dev-mode badge,
 * the theme toggle and sign-out. Its route guards the session.
 */
export const AppLayout = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigate = useNavigate();
  const meta = useQuery(metaQuery);
  const signOut = useToastMutation(signOutMutation, {
    error: "Could not sign out",
  });
  return (
    <AppShell
      brandBadge={
        meta.data?.devMode === true ? (
          <Badge
            title="Dev mode: fast intervals, /_dev fixtures"
            variant="warning"
          >
            Dev
          </Badge>
        ) : null
      }
      footer={
        <>
          <ThemeToggle />
          <Button
            disabled={signOut.isPending}
            onClick={() =>
              signOut.mutate(undefined, {
                onSuccess: () => navigate({ replace: true, to: "/login" }),
              })
            }
            size="sm"
            variant="ghost"
          >
            Sign out
          </Button>
        </>
      }
      nav={
        <>
          <AppShellNavLink
            active={isDashboardPath(pathname)}
            render={<Link activeOptions={{ exact: true }} to="/" />}
          >
            Dashboard
          </AppShellNavLink>
          <AppShellNavLink render={<Link to="/channels" />}>
            Channels
          </AppShellNavLink>
          <AppShellNavLink
            render={<Link rel="noopener" target="_blank" to="/status" />}
          >
            Status page
            <span aria-hidden {...stylex.props(styles.external)}>
              ↗
            </span>
            <span {...stylex.props(shared.srOnly)}>(opens in a new tab)</span>
          </AppShellNavLink>
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
};

/** A route loading (the router's `pendingComponent`). */
export const RoutePending = () => <PageSkeleton />;

/**
 * A route failed (the router's `errorComponent`): the API error, a retry
 * that re-runs the loaders, and a way back.
 */
export const RouteError = ({ error, reset }: ErrorComponentProps) => {
  const router = useRouter();
  const queryErrors = useQueryErrorResetBoundary();
  useEffect(() => {
    // Let suspense queries of this route fetch again on retry.
    queryErrors.reset();
  }, [queryErrors]);
  return (
    <ErrorPanel
      actions={
        <Link to="/" {...buttonStyles({ size: "sm", variant: "ghost" })}>
          Dashboard
        </Link>
      }
      error={error instanceof Error ? error : new Error(String(error))}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
};

/** A failure outside the app shell (the session check, the root). */
export const StandaloneRouteError = (props: ErrorComponentProps) => (
  <CenteredScreen>
    <div {...stylex.props(styles.standalone)}>
      <RouteError {...props} />
    </div>
  </CenteredScreen>
);

/** Inside the shell: a route or a record (a monitor) that does not exist. */
export const NotFoundPanel = () => (
  <EmptyState
    action={
      <Link to="/" {...buttonStyles({ variant: "outline" })}>
        Back to the dashboard
      </Link>
    }
    description="It does not exist, or it was deleted."
    heading="h1"
    title="Not found"
  />
);

/** A route outside the shell loading (the session check). */
export const StandalonePending = () => (
  <CenteredScreen>
    <div {...stylex.props(styles.standalone)}>
      <PageSkeleton rows={3} />
    </div>
  </CenteredScreen>
);
