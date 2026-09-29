import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";

import { uptimeOfLastDays } from "../../../src/domain/history.ts";
import type { PublicMonitor } from "../../../src/domain/public-status.ts";
import { publicStatusQuery } from "../api/queries.ts";
import { EmptyState } from "../components/empty-state.tsx";
import { RelativeTime } from "../components/relative-time.tsx";
import {
  StatusBanner,
  statusBannerView,
} from "../components/status-banner.tsx";
import { StatusBadge } from "../components/status.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { shared } from "../components/ui/shared.ts";
import { UptimeBars, UptimeLegend } from "../components/uptime-bars.tsx";
import {
  formatDateTime,
  formatDuration,
  formatPercent,
} from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  media,
  radius,
  shadows,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";

/** Days of history per monitor (the API's default). */
const historyDays = 90;
/** Narrow screens: fewer, still legible bars (2px each plus a 2px gap). */
const narrowDays = 60;
const wideQuery = "(min-width: 640px)";

/** Whether the viewport is wide enough for all 90 bars. */
const useWide = () =>
  useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(wideQuery);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(wideQuery).matches
  );

const styles = stylex.create({
  axis: {
    alignItems: "baseline",
    display: "flex",
    gap: space.md,
    justifyContent: "space-between",
  },
  axisUptime: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
    fontVariantNumeric: "tabular-nums",
  },
  bar: {
    alignItems: "center",
    display: "flex",
    gap: space.md,
    justifyContent: "space-between",
    paddingBlock: space.lg,
  },
  brand: {
    alignItems: "center",
    color: colors.foreground,
    display: "flex",
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
  },
  brandSection: {
    borderLeftColor: colors.border,
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    color: colors.mutedForeground,
    fontWeight: fontWeights.medium,
    marginLeft: space.xs,
    paddingLeft: space.md,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    marginInline: "auto",
    maxWidth: "52rem",
    paddingInline: { default: space.lg, [media.md]: space.xl },
    width: "100%",
  },
  footer: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    letterSpacing: tracking.wide,
    paddingBlock: space.xl,
    textAlign: "center",
    textTransform: "uppercase",
  },
  incident: {
    alignItems: { default: "flex-start", [media.md]: "center" },
    borderTopColor: colors.border,
    borderTopStyle: { ":first-child": "none", default: "solid" },
    borderTopWidth: "1px",
    display: "flex",
    flexDirection: { default: "column", [media.md]: "row" },
    gap: { default: space.xs, [media.md]: space.lg },
    justifyContent: "space-between",
    paddingBlock: space.md,
    paddingInline: space.lg,
  },
  incidentName: {
    fontWeight: fontWeights.medium,
    overflowWrap: "anywhere",
  },
  incidentTime: {
    color: colors.dangerForeground,
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    paddingBlock: { default: space.md, [media.md]: space.xl },
  },
  // The app shell's mark: a frame with a filled core.
  mark: {
    "::after": {
      backgroundColor: "currentColor",
      content: '""',
      flexGrow: 1,
    },
    borderColor: "currentColor",
    borderStyle: "solid",
    borderWidth: "1px",
    display: "inline-flex",
    height: "1rem",
    padding: "3px",
    width: "1rem",
  },
  metaError: {
    color: colors.dangerForeground,
  },
  monitor: {
    borderTopColor: colors.border,
    borderTopStyle: { ":first-child": "none", default: "solid" },
    borderTopWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    paddingBlock: space.lg,
    paddingInline: { default: space.lg, [media.md]: space.xl },
  },
  monitorHead: {
    alignItems: "center",
    display: "flex",
    gap: space.md,
    justifyContent: "space-between",
  },
  monitorName: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.tight,
    margin: 0,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  // A panel on the grid: the card surface with the ink title bar.
  panel: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.sm,
    color: colors.cardForeground,
    overflow: "hidden",
  },
  panelBar: {
    alignItems: "center",
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
    display: "flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    justifyContent: "space-between",
    letterSpacing: tracking.wider,
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: { default: space.lg, [media.md]: space.xl },
    textTransform: "uppercase",
  },
  panelBarDanger: {
    backgroundColor: colors.destructive,
    color: colors.destructiveForeground,
  },
  panelTitle: {
    fontSize: "inherit",
    fontWeight: fontWeights.medium,
    margin: 0,
  },
  // Parchment with a faint survey grid, like the other public screens.
  root: {
    backgroundColor: colors.background,
    backgroundImage: `linear-gradient(to right, color-mix(in srgb, ${colors.border} 35%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, ${colors.border} 35%, transparent) 1px, transparent 1px)`,
    backgroundPosition: "center top",
    backgroundSize: "2rem 2rem",
    color: colors.foreground,
    display: "flex",
    flexDirection: "column",
    fontSize: fontSizes.md,
    minHeight: "100dvh",
  },
  spacer: {
    flexGrow: 1,
  },
});

/** Seconds between refreshes, in words (the query's `refetchInterval`). */
const refreshEvery = "Refreshes every minute";

const MonitorRow = ({
  days,
  monitor,
}: {
  readonly days: number;
  readonly monitor: PublicMonitor;
}) => {
  // Over the days the bars show, not the 90 the API reports.
  const uptime = formatPercent(uptimeOfLastDays(monitor.days, days));
  return (
    <li {...stylex.props(styles.monitor)}>
      <div {...stylex.props(styles.monitorHead)}>
        <h3 {...stylex.props(styles.monitorName)}>{monitor.name}</h3>
        <StatusBadge status={monitor.status} />
      </div>
      <UptimeBars
        count={days}
        days={monitor.days}
        label={`${monitor.name}: ${uptime} uptime over ${days} days`}
        showAxis={false}
      />
      <div aria-hidden {...stylex.props(styles.axis)}>
        <span {...stylex.props(shared.label)}>{days} days ago</span>
        <span {...stylex.props(styles.axisUptime)}>{uptime} uptime</span>
        <span {...stylex.props(shared.label)}>Today</span>
      </div>
    </li>
  );
};

const OpenIncidents = ({
  monitors,
}: {
  readonly monitors: readonly PublicMonitor[];
}) => {
  const now = useNow();
  const open = monitors.filter(
    (monitor) => monitor.status === "down" && monitor.downSince !== null
  );
  if (open.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="incidents-title" {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.panelBar, styles.panelBarDanger)}>
        <h2 id="incidents-title" {...stylex.props(styles.panelTitle)}>
          Open incidents
        </h2>
        <span aria-hidden>[ {String(open.length).padStart(2, "0")} ]</span>
      </div>
      <ul {...stylex.props(styles.list)}>
        {open.map((monitor) => {
          const since = monitor.downSince ?? now;
          return (
            <li key={monitor.ref} {...stylex.props(styles.incident)}>
              <span {...stylex.props(styles.incidentName)}>
                {monitor.name} is down
              </span>
              <span {...stylex.props(styles.incidentTime)}>
                Since {formatDateTime(since)} · {formatDuration(now - since)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/**
 * `/status`: the public status page (no session, no app shell): the
 * overall status, open incidents and each public monitor's last 90 days
 * (60 on narrow screens), its uptime over the same days. It
 * reads `GET /api/public/status` only, which never carries URLs.
 */
export const StatusPage = () => {
  const status = useSuspenseQuery(publicStatusQuery);
  const { generatedAt, monitors, overall } = status.data;
  const { title } = statusBannerView(overall, monitors);
  const days = useWide() ? historyDays : narrowDays;

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Status · Kanshi`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <div {...stylex.props(styles.root)}>
      <header {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.bar)}>
          <span {...stylex.props(styles.brand)}>
            <span aria-hidden {...stylex.props(styles.mark)} />
            Kanshi
            <span {...stylex.props(styles.brandSection)}>Status</span>
          </span>
          <ThemeToggle />
        </div>
      </header>
      <main {...stylex.props(styles.column, styles.main)}>
        <h1 {...stylex.props(shared.srOnly)}>Service status</h1>
        <StatusBanner
          meta={
            status.isRefetchError ? (
              <span {...stylex.props(styles.metaError)}>
                Could not refresh · last updated{" "}
                <RelativeTime at={generatedAt} />
              </span>
            ) : (
              <>
                Updated <RelativeTime at={generatedAt} /> · {refreshEvery}
              </>
            )
          }
          monitors={monitors}
          overall={overall}
        />
        <OpenIncidents monitors={monitors} />
        {monitors.length === 0 ? (
          <EmptyState
            description="Monitors appear here once they are made public."
            title="Nothing to report yet"
          />
        ) : (
          <section
            aria-labelledby="monitors-title"
            {...stylex.props(styles.panel)}
          >
            <div {...stylex.props(styles.panelBar)}>
              <h2 id="monitors-title" {...stylex.props(styles.panelTitle)}>
                Monitors
              </h2>
              <span>Uptime // {days} days</span>
            </div>
            <ul {...stylex.props(styles.list)}>
              {monitors.map((monitor) => (
                <MonitorRow days={days} key={monitor.ref} monitor={monitor} />
              ))}
            </ul>
          </section>
        )}
        {monitors.length === 0 ? null : <UptimeLegend />}
      </main>
      <div {...stylex.props(styles.spacer)} />
      <footer {...stylex.props(styles.column, styles.footer)}>
        Kanshi // uptime monitor
      </footer>
    </div>
  );
};
