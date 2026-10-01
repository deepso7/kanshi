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
import { StatusFrame, panelStyles } from "../components/status-frame.tsx";
import { StatusBadge } from "../components/status.tsx";
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
  space,
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
    paddingInline: { default: space.lg, [media.md]: space.xl },
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
  panelAsideDanger: {
    color: colors.dangerForeground,
  },
  panelEmpty: {
    color: colors.mutedForeground,
    margin: 0,
    paddingBlock: space.lg,
    paddingInline: { default: space.lg, [media.md]: space.xl },
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

/** Down, with the time it went down: one row in the incidents panel. */
const isOpenIncident = (monitor: PublicMonitor) =>
  monitor.status === "down" && monitor.downSince !== null;

const OpenIncidents = ({
  monitors,
}: {
  readonly monitors: readonly PublicMonitor[];
}) => {
  const now = useNow();
  const open = monitors.filter(isOpenIncident);
  return (
    <section
      aria-labelledby="incidents-title"
      {...stylex.props(panelStyles.panel)}
    >
      <div {...stylex.props(panelStyles.bar)}>
        <h2 id="incidents-title" {...stylex.props(panelStyles.title)}>
          Open incidents
        </h2>
        {open.length === 0 ? null : (
          <span
            aria-hidden
            {...stylex.props(panelStyles.aside, styles.panelAsideDanger)}
          >
            {open.length} open
          </span>
        )}
      </div>
      {open.length === 0 ? (
        <p {...stylex.props(styles.panelEmpty)}>No open incidents.</p>
      ) : (
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
      )}
    </section>
  );
};

/**
 * `/status`: the public status page (no session, no app shell): the
 * overall status, each public monitor's last 90 days
 * (60 on narrow screens) and its uptime over the same days, and the
 * open incidents (above the monitors while there are any). It
 * reads `GET /api/public/status` only, which never carries URLs.
 */
export const StatusPage = () => {
  const status = useSuspenseQuery(publicStatusQuery);
  const { generatedAt, monitors, overall } = status.data;
  const { title } = statusBannerView(overall, monitors);
  const days = useWide() ? historyDays : narrowDays;
  const anyDown = monitors.some(isOpenIncident);

  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Status · Kanshi`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <StatusFrame>
      <h1 {...stylex.props(shared.srOnly)}>Service status</h1>
      <StatusBanner
        meta={
          status.isRefetchError ? (
            <span {...stylex.props(styles.metaError)}>
              Could not refresh · last updated <RelativeTime at={generatedAt} />
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
      {/* First while something is down; a quiet footnote otherwise. */}
      {anyDown ? <OpenIncidents monitors={monitors} /> : null}
      {monitors.length === 0 ? (
        <EmptyState
          description="Monitors appear here once they are made public."
          title="Nothing to report yet"
        />
      ) : (
        <section
          aria-labelledby="monitors-title"
          {...stylex.props(panelStyles.panel)}
        >
          <div {...stylex.props(panelStyles.bar)}>
            <h2 id="monitors-title" {...stylex.props(panelStyles.title)}>
              Monitors
            </h2>
            <span {...stylex.props(panelStyles.aside)}>
              Uptime // {days} days
            </span>
          </div>
          <ul {...stylex.props(styles.list)}>
            {monitors.map((monitor) => (
              <MonitorRow days={days} key={monitor.ref} monitor={monitor} />
            ))}
          </ul>
        </section>
      )}
      {monitors.length === 0 ? null : <UptimeLegend />}
      {monitors.length === 0 || anyDown ? null : (
        <OpenIncidents monitors={monitors} />
      )}
    </StatusFrame>
  );
};
