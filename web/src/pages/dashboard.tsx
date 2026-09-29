import * as stylex from "@stylexjs/stylex";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { OverviewMonitor, StatusCounts } from "../../../src/api/spec.ts";
import { displayStatus } from "../../../src/domain/monitor.ts";
import type { Episode } from "../../../src/domain/watchdog.ts";
import {
  devEventsQuery,
  episodesQuery,
  metaQuery,
  overviewQuery,
} from "../api/queries.ts";
import { EmptyState } from "../components/empty-state.tsx";
import { ErrorPanel } from "../components/error-panel.tsx";
import { PageHeader } from "../components/page-header.tsx";
import {
  combinedUptime,
  latencyRange,
  latencyValues,
  latestLatency,
  uptimeTone,
} from "../components/recent-activity.ts";
import { RelativeTime } from "../components/relative-time.tsx";
import { Sparkline } from "../components/sparkline.tsx";
import { StatCard } from "../components/stat-card.tsx";
import type { MonitorStatus } from "../components/status.tsx";
import { StatusBadge, StatusDot } from "../components/status.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { buttonStyles } from "../components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { PlusIcon } from "../components/ui/icons.tsx";
import { shared } from "../components/ui/shared.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Table, TableHead, TableRow } from "../components/ui/table.tsx";
import { formatInterval, formatLatency, formatPercent } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  media,
  radius,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";

/** The overview refreshes faster than its shared default (30 s). */
const refreshMs = 15_000;

const blink = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.25 },
});

const styles = stylex.create({
  header: {
    marginBottom: 0,
  },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  sectionCount: {
    fontFamily: fonts.mono,
  },
  sectionHead: {
    alignItems: "baseline",
    display: "flex",
    gap: space.md,
    justifyContent: "space-between",
  },
  sectionTitle: {
    "::before": {
      backgroundColor: "currentColor",
      content: '""',
      flexShrink: 0,
      height: "0.4375rem",
      width: "0.4375rem",
    },
    alignItems: "center",
    display: "flex",
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
});

// -- live indicator ----------------------------------------------------------

const liveStyles = stylex.create({
  busy: {
    animationDuration: "0.9s",
    animationIterationCount: "infinite",
    animationName: {
      "@media (prefers-reduced-motion: reduce)": "none",
      default: blink,
    },
    animationTimingFunction: "steps(2, jump-none)",
  },
  dot: {
    backgroundColor: colors.success,
    flexShrink: 0,
    height: "0.4375rem",
    width: "0.4375rem",
  },
  dotError: {
    backgroundColor: colors.danger,
  },
  root: {
    alignItems: "center",
    color: colors.mutedForeground,
    display: "inline-flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gap: space.sm,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
  rootError: {
    color: colors.dangerForeground,
  },
});

/** "Live · updated 12s ago", blinking while a refresh is in flight. */
const LiveIndicator = ({
  failed,
  fetching,
  updatedAt,
}: {
  readonly failed: boolean;
  readonly fetching: boolean;
  readonly updatedAt: number;
}) => (
  <span
    aria-live="polite"
    {...stylex.props(liveStyles.root, failed && liveStyles.rootError)}
  >
    <span
      aria-hidden
      {...stylex.props(
        liveStyles.dot,
        failed && liveStyles.dotError,
        fetching && liveStyles.busy
      )}
    />
    {failed ? "Refresh failed" : "Live"} · <RelativeTime at={updatedAt} />
  </span>
);

// -- summary -----------------------------------------------------------------

const statsStyles = stylex.create({
  featured: {
    gridColumn: { default: "1 / -1", [media.lg]: "auto" },
  },
  grid: {
    display: "grid",
    gap: space.md,
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [media.md]: "repeat(4, minmax(0, 1fr))",
      [media.lg]: "minmax(0, 1.7fr) repeat(4, minmax(0, 1fr))",
    },
  },
  label: {
    alignItems: "center",
    display: "inline-flex",
    gap: space.sm,
  },
  // The fleet's composition: one segment per status, sized by its count.
  strip: {
    borderRadius: radius.sm,
    display: "flex",
    gap: "2px",
    height: "0.375rem",
    overflow: "hidden",
  },
  stripEmpty: {
    backgroundColor: colors.muted,
    flexGrow: 1,
  },
});

const segments = stylex.create({
  down: { backgroundColor: colors.danger },
  paused: {
    backgroundColor: colors.muted,
    backgroundImage: `repeating-linear-gradient(135deg, ${colors.unknown} 0 1px, transparent 1px 4px)`,
  },
  unknown: { backgroundColor: colors.unknown },
  up: { backgroundColor: colors.success },
});

const stripOrder = ["up", "down", "unknown", "paused"] as const;

const FleetStrip = ({ counts }: { readonly counts: StatusCounts }) => {
  const total = stripOrder.reduce((sum, status) => sum + counts[status], 0);
  return (
    <div aria-hidden {...stylex.props(statsStyles.strip)}>
      {total === 0 ? <span {...stylex.props(statsStyles.stripEmpty)} /> : null}
      {stripOrder
        .filter((status) => counts[status] > 0)
        .map((status) => (
          <span
            key={status}
            style={{ flexGrow: counts[status] }}
            {...stylex.props(segments[status])}
          />
        ))}
    </div>
  );
};

const StatusLabel = ({
  children,
  status,
}: {
  readonly children: ReactNode;
  readonly status: MonitorStatus;
}) => (
  <span {...stylex.props(statsStyles.label)}>
    <StatusDot label="" size="sm" status={status} />
    {children}
  </span>
);

const plural = (count: number, noun: string) =>
  `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

const SummaryCards = ({
  counts,
  monitors,
}: {
  readonly counts: StatusCounts;
  readonly monitors: readonly OverviewMonitor[];
}) => {
  const recents = monitors.map((monitor) => monitor.recent);
  const uptime = combinedUptime(recents);
  const checks = recents.reduce(
    (sum, recent) => sum + (recent?.counted ?? 0),
    0
  );
  return (
    <section aria-label="Summary" {...stylex.props(statsStyles.grid)}>
      <StatCard
        hint={
          checks === 0
            ? "No checks in the last 24 hours"
            : `${plural(checks, "check")} across ${plural(monitors.length, "monitor")}`
        }
        label="Uptime // 24h"
        style={statsStyles.featured}
        tone={uptimeTone(uptime)}
        value={formatPercent(uptime)}
      >
        <FleetStrip counts={counts} />
      </StatCard>
      <StatCard
        hint={`of ${plural(monitors.length, "monitor")}`}
        label={<StatusLabel status="up">Up</StatusLabel>}
        tone={counts.up > 0 ? "success" : "muted"}
        value={counts.up}
      />
      <StatCard
        hint={counts.down > 0 ? "Needs attention" : "All clear"}
        label={<StatusLabel status="down">Down</StatusLabel>}
        tone={counts.down > 0 ? "danger" : "muted"}
        value={counts.down}
      />
      <StatCard
        hint="Awaiting a result"
        label={<StatusLabel status="unknown">Unknown</StatusLabel>}
        tone={counts.unknown > 0 ? "default" : "muted"}
        value={counts.unknown}
      />
      <StatCard
        hint="Checks disabled"
        label={<StatusLabel status="paused">Paused</StatusLabel>}
        tone={counts.paused > 0 ? "default" : "muted"}
        value={counts.paused}
      />
    </section>
  );
};

// -- not being checked -------------------------------------------------------

const watchStyles = stylex.create({
  item: {
    alignItems: { default: "flex-start", [media.md]: "baseline" },
    borderTopColor: colors.warning,
    borderTopStyle: "dashed",
    borderTopWidth: "1px",
    display: "flex",
    flexDirection: { default: "column", [media.md]: "row" },
    gap: { default: space.xxs, [media.md]: space.md },
    justifyContent: "space-between",
    paddingBlock: space.sm,
  },
  link: {
    color: colors.foreground,
    fontWeight: fontWeights.semibold,
    overflowWrap: "anywhere",
    textDecorationColor: colors.warning,
    textDecorationLine: { ":hover": "underline", default: "none" },
    textUnderlineOffset: "3px",
  },
  list: {
    listStyle: "none",
    margin: 0,
    marginTop: space.sm,
    padding: 0,
  },
  meta: {
    color: colors.warningForeground,
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
  },
  root: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
    borderLeftWidth: "3px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    paddingBlock: space.lg,
    paddingInline: space.lg,
  },
  text: {
    color: colors.foreground,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  title: {
    color: colors.warningForeground,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
});

/** Open watchdog episodes: monitors whose checks stopped arriving. */
const NotCheckedBanner = ({
  episodes,
}: {
  readonly episodes: readonly Episode[];
}) => {
  const now = useNow();
  if (episodes.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="not-checked-title"
      role="alert"
      {...stylex.props(watchStyles.root)}
    >
      <span {...stylex.props(shared.label)}>Watchdog</span>
      <h2 id="not-checked-title" {...stylex.props(watchStyles.title)}>
        {episodes.length === 1
          ? "1 monitor is not being checked"
          : `${episodes.length} monitors are not being checked`}
      </h2>
      <p {...stylex.props(watchStyles.text)}>
        Their checks are overdue, so the status shown may be stale. The hourly
        watchdog restarts them; this clears on its first run after they resume.
      </p>
      <ul {...stylex.props(watchStyles.list)}>
        {episodes.map((episode) => (
          <li key={episode.id} {...stylex.props(watchStyles.item)}>
            <Link
              params={{ id: episode.monitorId }}
              to="/monitors/$id"
              {...stylex.props(watchStyles.link, shared.focusRing)}
            >
              {episode.monitorName}
            </Link>
            <span {...stylex.props(watchStyles.meta)}>
              Last check <RelativeTime at={episode.lastCheckedAt} now={now} /> ·
              every {formatInterval(episode.intervalSeconds)} · overdue since{" "}
              <RelativeTime at={episode.startedAt} now={now} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

// -- monitor table -----------------------------------------------------------

const tableStyles = stylex.create({
  badges: {
    alignItems: "center",
    display: "inline-flex",
    flexWrap: "wrap",
    gap: space.xs,
  },
  // Below `lg` each row is a small grid card; from `lg` a table row.
  body: {
    display: { default: "block", [media.lg]: "table-row-group" },
  },
  cell: {
    display: { default: "block", [media.lg]: "table-cell" },
    minWidth: 0,
    paddingBlock: { default: 0, [media.lg]: space.md },
    paddingInline: { default: 0, [media.lg]: space.md },
    verticalAlign: "middle",
  },
  cellInterval: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gridArea: "interval",
    textAlign: { default: "start", [media.lg]: "end" },
    whiteSpace: "nowrap",
  },
  cellLast: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gridArea: "last",
    whiteSpace: "nowrap",
  },
  cellLatency: {
    alignSelf: "center",
    gridArea: "latency",
    width: { default: "auto", [media.lg]: "11rem" },
  },
  cellMonitor: {
    gridArea: "monitor",
    maxWidth: { default: "none", [media.lg]: "22rem" },
  },
  cellStatus: {
    gridArea: "status",
    width: { default: "auto", [media.lg]: "6.5rem" },
  },
  cellUptime: {
    fontFamily: fonts.mono,
    fontVariantNumeric: "tabular-nums",
    gridArea: "uptime",
    justifySelf: "end",
    textAlign: "end",
    whiteSpace: "nowrap",
  },
  head: {
    display: { default: "none", [media.lg]: "table-header-group" },
  },
  headEnd: {
    textAlign: "end",
  },
  latency: {
    alignItems: "center",
    display: "flex",
    gap: space.sm,
  },
  latencyValue: {
    color: colors.mutedForeground,
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    minWidth: "3.75rem",
    textAlign: "end",
  },
  // Only in the stacked (narrow) layout: "Checked", "Every".
  mobileOnly: {
    display: { default: "inline", [media.lg]: "none" },
  },
  name: {
    // Stretched over the row: the whole row opens the monitor.
    "::after": {
      content: '""',
      inset: 0,
      position: "absolute",
    },
    color: colors.foreground,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    outline: "none",
    overflowWrap: "anywhere",
    textDecorationColor: colors.border,
    textDecorationLine: "none",
    textUnderlineOffset: "3px",
  },
  nameLine: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
  },
  paused: {
    opacity: 0.72,
  },
  row: {
    columnGap: space.lg,
    display: { default: "grid", [media.lg]: "table-row" },
    gridTemplateAreas: `"status uptime" "monitor monitor" "last latency" "interval latency"`,
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 11rem)",
    // The stretched link's focus ring, on the whole row.
    outlineColor: colors.ring,
    outlineOffset: "-2px",
    outlineStyle: { ":has(a:focus-visible)": "solid", default: "none" },
    outlineWidth: "1px",
    paddingBlock: { default: space.md, [media.lg]: 0 },
    paddingInline: { default: space.lg, [media.lg]: 0 },
    position: "relative",
    rowGap: space.xs,
  },
  // A percentage width collapses in an auto-sized table cell.
  sparkline: {
    flexGrow: 1,
    minWidth: "5rem",
    width: "auto",
  },
  table: {
    display: { default: "block", [media.lg]: "table" },
  },
  uptimeSuffix: {
    color: colors.mutedForeground,
    fontSize: fontSizes.xs,
    marginLeft: space.xs,
  },
  url: {
    color: colors.mutedForeground,
    display: "block",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    marginTop: space.xxs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const uptimeTones = stylex.create({
  danger: { color: colors.dangerForeground },
  muted: { color: colors.mutedForeground },
  success: { color: colors.successForeground },
  warning: { color: colors.warningForeground },
});

/** The target URL; empty on a Registry row not refreshed yet. */
const MonitorUrl = ({ url }: { readonly url: string }) =>
  url === "" ? null : (
    <span title={url} {...stylex.props(tableStyles.url)}>
      {url}
    </span>
  );

const MonitorRow = ({
  monitor,
  now,
}: {
  readonly monitor: OverviewMonitor;
  readonly now: number;
}) => {
  const status = displayStatus(monitor);
  const { recent } = monitor;
  const uptime = recent?.uptimePercent ?? null;
  const range = latencyRange(recent);
  return (
    <TableRow
      data-status={status}
      style={[tableStyles.row, status === "paused" && tableStyles.paused]}
    >
      <td {...stylex.props(tableStyles.cell, tableStyles.cellStatus)}>
        <StatusBadge status={status} />
      </td>
      <td {...stylex.props(tableStyles.cell, tableStyles.cellMonitor)}>
        <div {...stylex.props(tableStyles.nameLine)}>
          <Link
            params={{ id: monitor.id }}
            to="/monitors/$id"
            {...stylex.props(tableStyles.name)}
          >
            {monitor.name}
          </Link>
          <span {...stylex.props(tableStyles.badges)}>
            {monitor.notChecked ? (
              <Badge variant="warning">Not checked</Badge>
            ) : null}
            {monitor.public ? <Badge variant="outline">Public</Badge> : null}
            {monitor.managed ? (
              <Badge variant="secondary">Managed</Badge>
            ) : null}
          </span>
        </div>
        <MonitorUrl url={monitor.url} />
      </td>
      <td {...stylex.props(tableStyles.cell, tableStyles.cellLast)}>
        <span {...stylex.props(tableStyles.mobileOnly)}>Checked </span>
        {/* Read live with the row's activity; unknown if that failed. */}
        {recent === null ? (
          "unavailable"
        ) : (
          <RelativeTime at={monitor.lastCheckedAt} now={now} />
        )}
      </td>
      <td
        {...stylex.props(
          tableStyles.cell,
          tableStyles.cellUptime,
          uptimeTones[uptimeTone(uptime)]
        )}
      >
        {formatPercent(uptime)}
        <span
          {...stylex.props(tableStyles.mobileOnly, tableStyles.uptimeSuffix)}
        >
          24h
        </span>
      </td>
      <td {...stylex.props(tableStyles.cell, tableStyles.cellLatency)}>
        <div {...stylex.props(tableStyles.latency)}>
          <Sparkline
            style={tableStyles.sparkline}
            label={
              range === null
                ? "No latency samples in the last 24 hours"
                : `Latency, last 24 hours: ${formatLatency(range.min)} to ${formatLatency(range.max)}`
            }
            tone={status === "down" ? "danger" : "default"}
            values={latencyValues(recent)}
          />
          <span aria-hidden {...stylex.props(tableStyles.latencyValue)}>
            {formatLatency(latestLatency(recent))}
          </span>
        </div>
      </td>
      <td {...stylex.props(tableStyles.cell, tableStyles.cellInterval)}>
        <span {...stylex.props(tableStyles.mobileOnly)}>Every </span>
        {formatInterval(monitor.intervalSeconds)}
      </td>
    </TableRow>
  );
};

const MonitorTable = ({
  monitors,
}: {
  readonly monitors: readonly OverviewMonitor[];
}) => {
  const now = useNow();
  return (
    <Card>
      <Table style={tableStyles.table}>
        <thead {...stylex.props(tableStyles.head)}>
          <TableRow header>
            <TableHead>Status</TableHead>
            <TableHead>Monitor</TableHead>
            <TableHead>Last check</TableHead>
            <TableHead style={tableStyles.headEnd}>Uptime 24h</TableHead>
            <TableHead>Latency 24h</TableHead>
            <TableHead style={tableStyles.headEnd}>Interval</TableHead>
          </TableRow>
        </thead>
        <tbody {...stylex.props(tableStyles.body)}>
          {monitors.map((monitor) => (
            <MonitorRow key={monitor.id} monitor={monitor} now={now} />
          ))}
        </tbody>
      </Table>
    </Card>
  );
};

// -- dev webhook events ------------------------------------------------------

const devStyles = stylex.create({
  code: {
    fontFamily: fonts.mono,
  },
  item: {
    alignItems: "baseline",
    borderTopColor: colors.border,
    borderTopStyle: { ":first-child": "none", default: "solid" },
    borderTopWidth: "1px",
    columnGap: space.md,
    display: "grid",
    gridTemplateAreas: {
      default: `"time tags" "message message"`,
      [media.md]: `"time tags message"`,
    },
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [media.md]: "5rem 15rem minmax(0, 1fr)",
    },
    paddingBlock: space.sm,
    paddingInline: space.lg,
    rowGap: space.xs,
  },
  list: {
    listStyle: "none",
    margin: 0,
    maxHeight: "26rem",
    overflowY: "auto",
    padding: 0,
    paddingBottom: space.xs,
  },
  message: {
    fontSize: fontSizes.sm,
    gridArea: "message",
    lineHeight: lineHeights.normal,
    margin: 0,
    overflowWrap: "anywhere",
  },
  skeleton: {
    height: "1.25rem",
    marginBottom: space.sm,
    marginInline: space.lg,
  },
  source: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  state: {
    paddingBottom: space.lg,
    paddingInline: space.lg,
  },
  tags: {
    alignItems: "center",
    display: "flex",
    gap: space.sm,
    gridArea: "tags",
    minWidth: 0,
  },
  time: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gridArea: "time",
    whiteSpace: "nowrap",
  },
});

const DevEventsPanel = () => {
  const now = useNow();
  const events = useQuery(devEventsQuery());
  let body: ReactNode;
  if (events.data !== undefined) {
    body =
      events.data.length === 0 ? (
        <div {...stylex.props(devStyles.state)}>
          <EmptyState
            description={
              <>
                Flip the demo target to trigger one:{" "}
                <code {...stylex.props(devStyles.code)}>
                  POST /_dev/target/flip/demo?up=false
                </code>
              </>
            }
            title="No alerts received yet"
          />
        </div>
      ) : (
        <ul {...stylex.props(devStyles.list)}>
          {events.data.map((event) => {
            const delivered =
              event.respondedWith !== null &&
              event.respondedWith >= 200 &&
              event.respondedWith < 300;
            return (
              <li key={event.id} {...stylex.props(devStyles.item)}>
                <RelativeTime
                  at={event.at}
                  now={now}
                  {...stylex.props(devStyles.time)}
                />
                <span {...stylex.props(devStyles.tags)}>
                  {event.respondedWith === null ? null : (
                    <Badge variant={delivered ? "success" : "danger"}>
                      {event.respondedWith}
                    </Badge>
                  )}
                  <span
                    title={`${event.kind} ${event.query ?? ""}`}
                    {...stylex.props(devStyles.source)}
                  >
                    {event.kind}
                    {event.query === null ? null : ` ${event.query}`}
                  </span>
                </span>
                <p {...stylex.props(devStyles.message)}>{event.message}</p>
              </li>
            );
          })}
        </ul>
      );
  } else if (events.error === null) {
    body = (
      <div aria-busy aria-label="Loading events">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} style={devStyles.skeleton} />
        ))}
      </div>
    );
  } else {
    body = (
      <div {...stylex.props(devStyles.state)}>
        <ErrorPanel error={events.error} onRetry={() => events.refetch()} />
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle heading="h2">Dev webhook events</CardTitle>
        <CardDescription>
          Alerts the dev sink (
          <code {...stylex.props(devStyles.code)}>/_dev/webhook</code>)
          received, newest first.
        </CardDescription>
        <CardAction>
          <Badge variant="warning">Dev</Badge>
        </CardAction>
      </CardHeader>
      {body}
    </Card>
  );
};

// -- page --------------------------------------------------------------------

const newMonitorLink = (
  <Link to="/monitors/new" {...buttonStyles({})}>
    <PlusIcon /> New monitor
  </Link>
);

/**
 * `/`: every monitor, its status and recent activity, the watchdog's
 * "not being checked" banner and, in dev mode, the dev webhook sink.
 * Refreshes on its own.
 */
export const DashboardPage = () => {
  const overview = useSuspenseQuery({
    ...overviewQuery(),
    refetchInterval: refreshMs,
  });
  const episodes = useQuery(episodesQuery);
  const meta = useQuery(metaQuery);
  const { counts, monitors } = overview.data;

  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        actions={
          <>
            <LiveIndicator
              failed={overview.isRefetchError}
              fetching={overview.isFetching}
              updatedAt={overview.dataUpdatedAt}
            />
            {newMonitorLink}
          </>
        }
        description="Everything Kanshi watches, and how it is doing."
        eyebrow="Overview"
        style={styles.header}
        title="Monitors"
      />
      <NotCheckedBanner episodes={episodes.data ?? []} />
      {monitors.length === 0 ? (
        <EmptyState
          action={newMonitorLink}
          heading="h2"
          description={
            <>
              Add a URL to watch here, or declare monitors in{" "}
              <code {...stylex.props(devStyles.code)}>kanshi.config.ts</code>{" "}
              and run <code {...stylex.props(devStyles.code)}>kanshi sync</code>
              .
            </>
          }
          title="No monitors yet"
        />
      ) : (
        <>
          <SummaryCards counts={counts} monitors={monitors} />
          <section
            aria-labelledby="monitors-title"
            {...stylex.props(styles.section)}
          >
            <div {...stylex.props(styles.sectionHead)}>
              <h2 id="monitors-title" {...stylex.props(styles.sectionTitle)}>
                All monitors
              </h2>
              <span {...stylex.props(shared.label, styles.sectionCount)}>
                [ {String(monitors.length).padStart(2, "0")} ]
              </span>
            </div>
            <MonitorTable monitors={monitors} />
          </section>
        </>
      )}
      {meta.data?.devMode === true ? <DevEventsPanel /> : null}
    </div>
  );
};
