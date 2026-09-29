import * as stylex from "@stylexjs/stylex";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";

import type { MonitorResponse } from "../../../src/api/spec.ts";
import type { OutboxState } from "../../../src/domain/alert.ts";
import type { ChannelView } from "../../../src/domain/channel.ts";
import type {
  Check,
  IncidentWithAlerts,
  RecentActivity,
  UptimeReport,
} from "../../../src/domain/history.ts";
import { uptimeOfLastDays } from "../../../src/domain/history.ts";
import type { CheckErrorKind } from "../../../src/domain/monitor.ts";
import { displayStatus } from "../../../src/domain/monitor.ts";
import {
  channelsQuery,
  checkMonitorMutation,
  deleteMonitorMutation,
  monitorChecksQuery,
  monitorIncidentsQuery,
  monitorPageReads,
  monitorQuery,
  monitorRecentQuery,
  monitorUptimeQuery,
  queryKeys,
  updateMonitorMutation,
} from "../api/queries.ts";
import { Callout } from "../components/callout.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { ErrorPanel } from "../components/error-panel.tsx";
import { LatencyChart } from "../components/latency-chart.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { RelativeTime } from "../components/relative-time.tsx";
import type { StatTone } from "../components/stat-card.tsx";
import { StatCard } from "../components/stat-card.tsx";
import { StatusBadge } from "../components/status.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/ui/alert-dialog.tsx";
import type { BadgeVariant } from "../components/ui/badge.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button, buttonStyles } from "../components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { shared } from "../components/ui/shared.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs.tsx";
import { SimpleTooltip } from "../components/ui/tooltip.tsx";
import {
  UptimeBars,
  UptimeLegend,
  degradedThreshold,
  upThreshold,
} from "../components/uptime-bars.tsx";
import {
  formatDateTime,
  formatDuration,
  formatInterval,
  formatLatency,
  formatPercent,
  formatUtc,
  missing,
} from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { useToastMutation } from "../lib/use-toast-mutation.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  media,
  radius,
  space,
} from "../theme/tokens.stylex.ts";

const route = getRouteApi("/_app/monitors/$id");

/** How often each read refreshes while the page is open. */
const refresh = {
  checks: 10_000,
  incidents: 15_000,
  monitor: 10_000,
  recent: 30_000,
  uptime: 60_000,
} as const;

/** Uptime bars: 90 days, or 45 where 90 would not fit (2px bars, 2px gaps). */
const uptimeDays = 90;
const narrowUptimeDays = 45;
const narrowQuery = "(max-width: 639px)";

const subscribeNarrow = (onChange: () => void) => {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** Whether the viewport is phone-sized. */
const useNarrowScreen = () =>
  useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(narrowQuery).matches,
    () => false
  );

/** The latency chart's window: the API's default 24h in 48 buckets. */
const recentWindowMs = 24 * 60 * 60 * 1000;
const recentBuckets = 48;

const styles = stylex.create({
  actions: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
  },
  alert: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: { ":first-child": 0, default: "1px" },
    columnGap: space.md,
    display: "grid",
    gridTemplateColumns: {
      default: "4.5rem minmax(0, 1fr) auto",
      [media.md]: "4.5rem minmax(0, 1fr) 6rem 6rem",
    },
    paddingBlock: space.sm,
    rowGap: space.xs,
  },
  alertAttempts: {
    color: colors.mutedForeground,
    display: { default: "none", [media.md]: "block" },
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    textAlign: "end",
  },
  alertError: {
    color: colors.dangerForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gridColumn: "2 / -1",
    overflowWrap: "anywhere",
  },
  alertEvent: {
    alignItems: "center",
    display: "flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gap: space.xs,
    textTransform: "uppercase",
  },
  alertState: {
    justifySelf: "end",
  },
  alerts: {
    display: "flex",
    flexDirection: "column",
  },
  cards: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [media.lg]: "repeat(4, minmax(0, 1fr))",
    },
  },
  cause: {
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    margin: 0,
    overflowWrap: "anywhere",
  },
  chartBody: {
    paddingTop: space.lg,
  },
  crumb: {
    color: { ":hover": colors.foreground, default: colors.mutedForeground },
    textDecoration: "none",
  },
  definition: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    minWidth: 0,
  },
  definitionValue: {
    fontSize: fontSizes.md,
    margin: 0,
    overflowWrap: "anywhere",
  },
  definitions: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      default: "repeat(auto-fill, minmax(12rem, 1fr))",
    },
    margin: 0,
  },
  detail: {
    color: colors.mutedForeground,
    fontSize: fontSizes.xs,
    maxWidth: "24rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  headerMeta: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
  },
  headerStack: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    marginTop: space.xs,
  },
  idText: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    overflowWrap: "anywhere",
  },
  incident: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
  },
  incidentHead: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
    justifyContent: "space-between",
  },
  incidentMeta: {
    alignItems: "center",
    color: colors.mutedForeground,
    display: "flex",
    flexWrap: "wrap",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gap: space.md,
  },
  incidentOpen: {
    borderLeftColor: colors.danger,
    borderLeftWidth: "3px",
  },
  incidents: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  kindNote: {
    color: colors.mutedForeground,
    fontSize: fontSizes.xs,
    marginLeft: space.xs,
  },
  latencyValue: {
    alignItems: "baseline",
    display: "inline-flex",
    gap: space.xs,
  },
  mono: {
    fontFamily: fonts.mono,
  },
  muted: {
    color: colors.mutedForeground,
  },
  nowrap: {
    whiteSpace: "nowrap",
  },
  num: {
    fontFamily: fonts.mono,
    textAlign: "end",
    whiteSpace: "nowrap",
  },
  numHead: {
    textAlign: "end",
  },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  pageHeader: {
    marginBottom: 0,
  },
  percent: {
    fontFamily: fonts.mono,
    fontSize: fontSizes.xl,
    fontVariantNumeric: "tabular-nums",
    fontWeight: fontWeights.medium,
  },
  sectionSkeleton: {
    height: "9rem",
  },
  settingsFoot: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    display: "flex",
    flexWrap: "wrap",
    gap: space.md,
    justifyContent: "space-between",
    marginTop: space.lg,
    paddingTop: space.lg,
  },
  settingsPanel: {
    padding: space.lg,
  },
  tabCount: {
    fontFamily: fonts.mono,
    opacity: 0.7,
  },
  tableCard: {
    overflow: "hidden",
  },
  tableFoot: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    display: "flex",
    justifyContent: "space-between",
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  textDanger: {
    color: colors.dangerForeground,
  },
  // Long names (a URL as a name) wrap instead of widening the page.
  titleText: {
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  url: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
    overflowWrap: "anywhere",
    textDecorationColor: colors.border,
    textDecorationLine: { ":hover": "underline", default: "none" },
    textUnderlineOffset: "3px",
  },
  urlLine: {
    alignItems: "baseline",
    display: "flex",
    gap: space.sm,
    minWidth: 0,
  },
  urlMethod: {
    backgroundColor: colors.muted,
    borderRadius: radius.sm,
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    paddingBlock: "0.0625rem",
    paddingInline: space.xs,
  },
});

// -- helpers -------------------------------------------------------------------

const uptimeTone = (percent: number | null | undefined): StatTone => {
  if (percent === null || percent === undefined) {
    return "muted";
  }
  if (percent >= upThreshold) {
    return "success";
  }
  return percent >= degradedThreshold ? "warning" : "danger";
};

const errorKindLabels = {
  connection: "Connection",
  dns: "DNS",
  keyword: "Keyword",
  network: "Network",
  status: "Bad status",
  timeout: "Timeout",
  tls: "TLS",
} satisfies Record<CheckErrorKind, string>;

const deliveryVariants = {
  delivered: "success",
  failed: "danger",
  pending: "warning",
  skipped: "unknown",
} satisfies Record<OutboxState, BadgeVariant>;

const resolutionLabels = {
  deleted: "Monitor deleted",
  disabled: "Paused",
  recovered: "Recovered",
} satisfies Record<NonNullable<IncidentWithAlerts["resolution"]>, string>;

type KindLabel = "Counted" | "Confirm" | "Manual";

const kindLabels = {
  confirm: "Confirm",
  manual: "Manual",
  scheduled: "Counted",
} satisfies Record<Check["kind"], KindLabel>;

const kindVariants = {
  Confirm: "warning",
  Counted: "outline",
  Manual: "secondary",
} satisfies Record<KindLabel, BadgeVariant>;

const channelNames = (channels: readonly ChannelView[] | undefined) =>
  new Map((channels ?? []).map((channel) => [channel.id, channel.name]));

const channelsText = (
  selection: MonitorResponse["channels"],
  channels: readonly ChannelView[] | undefined
): string => {
  if (selection === "all") {
    return "All channels";
  }
  if (selection.length === 0) {
    return "None (no alerts)";
  }
  const names = channelNames(channels);
  return selection.map((id) => names.get(id) ?? "(deleted channel)").join(", ");
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

// -- sections ------------------------------------------------------------------

/**
 * One section's read: its content once loaded (kept while a refresh
 * fails), else the error with a retry, else a skeleton.
 */
const QueryView = <A,>({
  children,
  query,
}: {
  readonly query: UseQueryResult<A>;
  readonly children: (data: A) => ReactNode;
}) => {
  if (query.data !== undefined) {
    return children(query.data);
  }
  if (query.error !== null) {
    return (
      <ErrorPanel
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return <Skeleton style={styles.sectionSkeleton} />;
};

/** Rows shown before "Show all". */
const checksPreview = 12;

const ChecksTable = ({ checks }: { readonly checks: readonly Check[] }) => {
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? checks : checks.slice(0, checksPreview);
  if (checks.length === 0) {
    return (
      <EmptyState
        description="The first check runs shortly after the monitor is created or resumed."
        title="No checks yet"
      />
    );
  }
  return (
    <Card style={styles.tableCard}>
      <Table>
        <TableHeader>
          <TableRow header>
            <TableHead>When</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Result</TableHead>
            <TableHead style={styles.numHead}>HTTP</TableHead>
            <TableHead style={styles.numHead}>Latency</TableHead>
            <TableHead>Detail</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((check) => {
            const kind = kindLabels[check.kind];
            return (
              <TableRow key={check.checkId}>
                <TableCell style={styles.nowrap}>
                  <RelativeTime at={check.at} now={now} />
                </TableCell>
                <TableCell style={styles.nowrap}>
                  {check.kind === "scheduled" ? (
                    <span>{kind}</span>
                  ) : (
                    <Badge variant={kindVariants[kind]}>{kind}</Badge>
                  )}
                  {check.counted === (check.kind === "scheduled") ? null : (
                    <span {...stylex.props(styles.kindNote)}>
                      {check.counted ? "counted" : "not counted"}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {check.ok ? (
                    <Badge variant="success">OK</Badge>
                  ) : (
                    <Badge variant="danger">
                      {check.errorKind === null
                        ? "Failed"
                        : errorKindLabels[check.errorKind]}
                    </Badge>
                  )}
                </TableCell>
                <TableCell style={styles.num}>
                  {check.status ?? missing}
                </TableCell>
                <TableCell style={styles.num}>
                  {formatLatency(check.latencyMs)}
                </TableCell>
                <TableCell>
                  {check.message === null ? (
                    <span {...stylex.props(styles.muted)}>{missing}</span>
                  ) : (
                    <span
                      title={check.message}
                      {...stylex.props(styles.detail)}
                    >
                      {check.message}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {checks.length > checksPreview ? (
        <div {...stylex.props(styles.tableFoot)}>
          <span {...stylex.props(shared.label)}>
            {shown.length} of {checks.length} latest checks
          </span>
          <Button
            onClick={() => setExpanded(!expanded)}
            size="sm"
            variant="ghost"
          >
            {expanded ? "Show fewer" : `Show all ${checks.length}`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
};

const IncidentCard = ({
  incident,
  names,
  now,
}: {
  readonly incident: IncidentWithAlerts;
  readonly names: ReadonlyMap<string, string>;
  readonly now: number;
}) => {
  const open = incident.resolvedAt === null;
  const duration = (incident.resolvedAt ?? now) - incident.startedAt;
  return (
    <Card style={[styles.incident, open && styles.incidentOpen]}>
      <div {...stylex.props(styles.incidentHead)}>
        <div {...stylex.props(styles.headerMeta)}>
          {open ? (
            <Badge variant="danger">Ongoing</Badge>
          ) : (
            <Badge variant="success">
              {incident.resolution === null
                ? "Resolved"
                : resolutionLabels[incident.resolution]}
            </Badge>
          )}
          {incident.lastHttpStatus === null ? null : (
            <Badge variant="outline">HTTP {incident.lastHttpStatus}</Badge>
          )}
        </div>
        <div {...stylex.props(styles.incidentMeta)}>
          <span title={formatUtc(incident.startedAt)}>
            {formatDateTime(incident.startedAt)}
          </span>
          <span>
            {open ? "for " : "lasted "}
            {formatDuration(duration)}
          </span>
        </div>
      </div>
      <p {...stylex.props(styles.cause)}>{incident.cause}</p>
      <div>
        <span {...stylex.props(shared.label)}>
          Alerts{" "}
          {incident.alerts.length === 0
            ? "(none sent)"
            : `(${incident.alerts.length})`}
        </span>
        {incident.alerts.length === 0 ? null : (
          <div {...stylex.props(styles.alerts)}>
            {incident.alerts.map((alert) => (
              <div
                key={`${alert.event}-${alert.channelId}`}
                {...stylex.props(styles.alert)}
              >
                <span {...stylex.props(styles.alertEvent)}>
                  {alert.event === "down" ? "▼" : "▲"} {alert.event}
                </span>
                <span>
                  {names.get(alert.channelId) ?? (
                    <span {...stylex.props(styles.muted)}>Deleted channel</span>
                  )}
                  {alert.combined ? (
                    <span {...stylex.props(styles.kindNote)}>
                      sent after recovery
                    </span>
                  ) : null}
                </span>
                <span {...stylex.props(styles.alertAttempts)}>
                  {plural(alert.attempts, "attempt", "attempts")}
                </span>
                <span {...stylex.props(styles.alertState)}>
                  <Badge variant={deliveryVariants[alert.state]}>
                    {alert.state}
                  </Badge>
                </span>
                {alert.lastError === null ? null : (
                  <span {...stylex.props(styles.alertError)}>
                    {alert.lastError}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
};

const IncidentList = ({
  channels,
  incidents,
}: {
  readonly incidents: readonly IncidentWithAlerts[];
  readonly channels: readonly ChannelView[] | undefined;
}) => {
  const now = useNow(5000);
  if (incidents.length === 0) {
    return (
      <EmptyState
        description="Nothing has gone wrong yet. Incidents open when the monitor goes down and close when it recovers."
        title="No incidents"
      />
    );
  }
  const names = channelNames(channels);
  return (
    <div {...stylex.props(styles.incidents)}>
      {incidents.map((incident) => (
        <IncidentCard
          incident={incident}
          key={incident.id}
          names={names}
          now={now}
        />
      ))}
    </div>
  );
};

const Definition = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  <div {...stylex.props(styles.definition)}>
    <dt {...stylex.props(shared.label)}>{label}</dt>
    <dd {...stylex.props(styles.definitionValue)}>{children}</dd>
  </div>
);

const SettingsPanel = ({
  channels,
  monitor,
}: {
  readonly monitor: MonitorResponse;
  readonly channels: readonly ChannelView[] | undefined;
}) => (
  <Card style={styles.settingsPanel}>
    <dl {...stylex.props(styles.definitions)}>
      <Definition label="Method">
        <span {...stylex.props(styles.mono)}>{monitor.method}</span>
      </Definition>
      <Definition label="Expected status">
        <span {...stylex.props(styles.mono)}>{monitor.expectedStatus}</span>
      </Definition>
      <Definition label="Body contains">
        {monitor.bodyContains === null ? (
          <span {...stylex.props(styles.muted)}>Not checked</span>
        ) : (
          <span {...stylex.props(styles.mono)}>“{monitor.bodyContains}”</span>
        )}
      </Definition>
      <Definition label="Interval">
        Every {formatInterval(monitor.intervalSeconds)}
      </Definition>
      <Definition label="Timeout">
        {formatDuration(monitor.timeoutMs)}
      </Definition>
      <Definition label="Down after">
        {plural(monitor.failureThreshold, "failure", "failures")}
      </Definition>
      <Definition label="Up after">
        {plural(monitor.successThreshold, "success", "successes")}
      </Definition>
      <Definition label="Alerts">
        {channelsText(monitor.channels, channels)}
      </Definition>
      <Definition label="Checking">
        {monitor.enabled ? "On" : "Paused"}
      </Definition>
      <Definition label="Status page">
        {monitor.public ? "Public" : "Private"}
      </Definition>
      <Definition label="Key">
        <span {...stylex.props(styles.mono)}>{monitor.key}</span>
      </Definition>
      <Definition label="Source">
        {monitor.managed ? "kanshi.config.ts" : "Dashboard or API"}
      </Definition>
      <Definition label="Created">
        <span title={formatUtc(monitor.createdAt)}>
          {formatDateTime(monitor.createdAt)}
        </span>
      </Definition>
      <Definition label="Updated">
        <span title={formatUtc(monitor.updatedAt)}>
          {formatDateTime(monitor.updatedAt)}
        </span>
      </Definition>
    </dl>
    <div {...stylex.props(styles.settingsFoot)}>
      <span {...stylex.props(styles.idText)}>ID {monitor.id}</span>
      <Link
        params={{ id: monitor.id }}
        to="/monitors/$id/edit"
        {...buttonStyles({ size: "sm", variant: "outline" })}
      >
        Edit settings
      </Link>
    </div>
  </Card>
);

// -- the page ------------------------------------------------------------------

const DeleteMonitor = ({ monitor }: { readonly monitor: MonitorResponse }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const remove = useToastMutation(deleteMonitorMutation, {
    error: "Could not delete the monitor",
    success: `Monitor "${monitor.name}" deleted`,
  });
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!remove.isPending) {
          setOpen(next);
        }
      }}
      open={open}
    >
      <AlertDialogTrigger
        render={<Button style={styles.textDanger} variant="outline" />}
      >
        Delete
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{monitor.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its checks, uptime history and incidents are deleted too. This
            cannot be undone.
            {monitor.managed
              ? " It is managed by config: the next kanshi sync creates it again unless you remove it from kanshi.config.ts."
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending} />
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={() => {
              // Leave first: the page's reads would 404 once it is gone.
              remove.mutate(monitor.id, {
                onSuccess: () => {
                  setOpen(false);
                  void navigate({ replace: true, to: "/" });
                },
              });
            }}
          >
            {remove.isPending ? "Deleting…" : "Delete monitor"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

const MonitorActions = ({ monitor }: { readonly monitor: MonitorResponse }) => {
  const client = useQueryClient();
  const check = useToastMutation(checkMonitorMutation, {
    error: "Could not start a check",
    success: "Check started",
  });
  const update = useToastMutation(updateMonitorMutation, {
    error: "Could not update the monitor",
    success: (_monitor, { patch }) => {
      if (patch.enabled !== undefined) {
        return patch.enabled ? "Monitor resumed" : "Monitor paused";
      }
      return patch.public === true
        ? "Listed on the status page"
        : "Removed from the status page";
    },
  });
  const busy = check.isPending || update.isPending;
  return (
    <div {...stylex.props(styles.actions)}>
      <SimpleTooltip
        content={
          monitor.enabled
            ? "Run a check now (not counted in uptime)"
            : "Resume the monitor to check it"
        }
      >
        <Button
          disabled={busy || !monitor.enabled}
          focusableWhenDisabled
          onClick={() =>
            check.mutate(monitor.id, {
              onSuccess: () => {
                // The probe finishes shortly after the 202: read it then.
                setTimeout(() => {
                  void client.invalidateQueries({
                    queryKey: queryKeys.monitor(monitor.id),
                  });
                }, 1500);
              },
            })
          }
        >
          {check.isPending ? "Checking…" : "Check now"}
        </Button>
      </SimpleTooltip>
      <Button
        disabled={busy}
        onClick={() =>
          update.mutate({
            id: monitor.id,
            patch: { enabled: !monitor.enabled },
          })
        }
        variant="outline"
      >
        {monitor.enabled ? "Pause" : "Resume"}
      </Button>
      <Button
        disabled={busy}
        onClick={() =>
          update.mutate({ id: monitor.id, patch: { public: !monitor.public } })
        }
        variant="outline"
      >
        {monitor.public ? "Make private" : "Make public"}
      </Button>
      <Link
        params={{ id: monitor.id }}
        to="/monitors/$id/edit"
        {...buttonStyles({ variant: "outline" })}
      >
        Edit
      </Link>
      <DeleteMonitor monitor={monitor} />
    </div>
  );
};

const LastCheckCard = ({ monitor }: { readonly monitor: MonitorResponse }) => {
  const now = useNow(5000);
  const last = monitor.state.lastResult;
  let hint: ReactNode = "Not checked yet";
  let tone: StatTone = "muted";
  if (last !== null) {
    const parts = [
      last.status === null ? null : `HTTP ${last.status}`,
      last.latencyMs === null ? null : formatLatency(last.latencyMs),
    ].filter((part) => part !== null);
    hint = last.ok
      ? ["OK", ...parts].join(" · ")
      : `${last.errorKind === null ? "Failed" : errorKindLabels[last.errorKind]}${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
    tone = last.ok ? "default" : "danger";
  }
  return (
    <StatCard
      hint={hint}
      label="Last check"
      tone={tone}
      value={<RelativeTime at={monitor.state.lastCheckedAt} now={now} />}
    />
  );
};

const PageBanners = ({ monitor }: { readonly monitor: MonitorResponse }) => (
  <>
    {monitor.notChecked ? (
      <Callout role="alert" title="Not being checked" tone="danger">
        There has been no check for longer than the interval allows. The hourly
        watchdog repairs the schedule on its own; if this stays, look at the
        Worker’s logs.
      </Callout>
    ) : null}
    {monitor.enabled ? null : (
      <Callout title="Paused">
        This monitor is not checked and sends no alerts. Its history is kept;
        resume it to start checking again.
      </Callout>
    )}
    {monitor.managed ? (
      <Callout title="Managed by config" tone="warning">
        This monitor comes from kanshi.config.ts. Edits made here are
        overwritten by the next kanshi sync; change the config instead.
      </Callout>
    ) : null}
  </>
);

const MonitorHeader = ({ monitor }: { readonly monitor: MonitorResponse }) => (
  <PageHeader
    actions={<MonitorActions monitor={monitor} />}
    description={
      <span {...stylex.props(styles.headerStack)}>
        <span {...stylex.props(styles.headerMeta)}>
          <StatusBadge
            status={displayStatus({
              enabled: monitor.enabled,
              status: monitor.state.status,
            })}
          />
          <Badge variant="outline">
            {monitor.public ? "Public" : "Private"}
          </Badge>
          {monitor.managed ? (
            <Badge variant="secondary">Managed by config</Badge>
          ) : null}
          <Badge variant="outline">
            Every {formatInterval(monitor.intervalSeconds)}
          </Badge>
        </span>
        <span {...stylex.props(styles.urlLine)}>
          <span {...stylex.props(styles.urlMethod)}>{monitor.method}</span>
          <a
            href={monitor.url}
            rel="noopener noreferrer"
            target="_blank"
            {...stylex.props(styles.url)}
          >
            {monitor.url}
            <span {...stylex.props(shared.srOnly)}> (opens in a new tab)</span>
          </a>
        </span>
      </span>
    }
    eyebrow={
      <>
        <Link to="/" {...stylex.props(styles.crumb)}>
          Monitors
        </Link>
        {monitor.key === monitor.id ? null : (
          <>
            {" / "}
            <span {...stylex.props(styles.mono)}>{monitor.key}</span>
          </>
        )}
      </>
    }
    style={styles.pageHeader}
    title={<span {...stylex.props(styles.titleText)}>{monitor.name}</span>}
  />
);

const StatCards = ({
  monitor,
  recent,
  uptime,
}: {
  readonly monitor: MonitorResponse;
  readonly recent: RecentActivity | undefined;
  readonly uptime: UptimeReport | undefined;
}) => {
  // Still loading (the value sits in a <p>: no block skeleton there).
  const skeleton = missing;
  const today = uptime?.days.at(-1);
  const p50 = today?.p50 ?? null;
  const p95 = today?.p95 ?? null;
  return (
    <div {...stylex.props(styles.cards)}>
      <StatCard
        hint={
          recent === undefined
            ? "Last 24 hours"
            : `Last 24 hours · ${plural(recent.counted, "check", "checks")}`
        }
        label="Uptime 24h"
        tone={uptimeTone(recent?.uptimePercent)}
        value={
          recent === undefined ? skeleton : formatPercent(recent.uptimePercent)
        }
      />
      <StatCard
        hint={
          uptime === undefined
            ? "Last 90 days"
            : `Last 90 days · ${plural(uptime.counted, "check", "checks")}`
        }
        label="Uptime 90d"
        tone={uptimeTone(uptime?.uptimePercent)}
        value={
          uptime === undefined ? skeleton : formatPercent(uptime.uptimePercent)
        }
      />
      <StatCard
        hint={
          p95 === null
            ? "Today (UTC), successful checks"
            : `p95 ${formatLatency(p95)} · today (UTC)`
        }
        label="Latency p50"
        tone={p50 === null ? "muted" : "default"}
        value={uptime === undefined ? skeleton : formatLatency(p50)}
      />
      <LastCheckCard monitor={monitor} />
    </div>
  );
};

const UptimeCard = ({
  uptime,
}: {
  readonly uptime: UseQueryResult<UptimeReport>;
}) => {
  const count = useNarrowScreen() ? narrowUptimeDays : uptimeDays;
  // Over the days the bars show, so the number matches them.
  const percent =
    uptime.data === undefined
      ? null
      : uptimeOfLastDays(uptime.data.days, count);
  return (
    <Card>
      <CardHeader>
        <CardTitle heading="h2">Uptime · {count} days</CardTitle>
        <CardDescription>
          One bar per UTC day; hover a bar for its uptime.
        </CardDescription>
        <CardAction>
          <span
            {...stylex.props(
              styles.percent,
              uptimeTone(percent) === "danger" && styles.textDanger
            )}
          >
            {formatPercent(percent)}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <QueryView query={uptime}>
          {(report) => (
            <UptimeBars
              count={count}
              days={report.days}
              label={`Uptime over ${count} days: ${formatPercent(uptimeOfLastDays(report.days, count))}`}
            />
          )}
        </QueryView>
      </CardContent>
      <CardFooter>
        <UptimeLegend />
      </CardFooter>
    </Card>
  );
};

const LatencyCard = ({
  recent,
}: {
  readonly recent: UseQueryResult<RecentActivity>;
}) => (
  <Card>
    <CardHeader>
      <CardTitle heading="h2">Latency · 24 hours</CardTitle>
      <CardDescription>
        Mean response time of successful checks, per half hour. The strip below
        marks half hours with failed checks.
      </CardDescription>
    </CardHeader>
    <CardContent style={styles.chartBody}>
      <QueryView query={recent}>
        {(activity) => (
          <LatencyChart
            bucketMs={recentWindowMs / recentBuckets}
            buckets={activity.buckets}
            label={`Latency over the last 24 hours; uptime ${formatPercent(activity.uptimePercent)}`}
            startLabel="24h ago"
          />
        )}
      </QueryView>
    </CardContent>
  </Card>
);

const TabCount = ({ count }: { readonly count: number | undefined }) =>
  count === undefined ? null : (
    <span {...stylex.props(styles.tabCount)}>{count}</span>
  );

const HistoryTabs = ({
  checks,
  incidents,
  monitor,
}: {
  readonly monitor: MonitorResponse;
  readonly checks: UseQueryResult<readonly Check[]>;
  readonly incidents: UseQueryResult<readonly IncidentWithAlerts[]>;
}) => {
  const channels = useQuery(channelsQuery);
  const openIncidents =
    incidents.data?.filter((incident) => incident.resolvedAt === null).length ??
    0;
  return (
    <Tabs defaultValue="checks">
      <TabsList>
        <TabsTrigger value="checks">
          Checks
          <TabCount count={checks.data?.length} />
        </TabsTrigger>
        <TabsTrigger value="incidents">
          Incidents
          {openIncidents > 0 ? (
            <Badge variant="danger">{openIncidents} open</Badge>
          ) : (
            <TabCount count={incidents.data?.length} />
          )}
        </TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="checks">
        <QueryView query={checks}>
          {(rows) => <ChecksTable checks={rows} />}
        </QueryView>
      </TabsContent>
      <TabsContent value="incidents">
        <QueryView query={incidents}>
          {(rows) => <IncidentList channels={channels.data} incidents={rows} />}
        </QueryView>
      </TabsContent>
      <TabsContent value="settings">
        <SettingsPanel channels={channels.data} monitor={monitor} />
      </TabsContent>
    </Tabs>
  );
};

/** `/monitors/$id`: one monitor's state, history and actions. */
export const MonitorDetailPage = () => {
  const { id } = route.useParams();
  // The loader warmed these exact keys; each refreshes on its own clock.
  const { data: monitor } = useSuspenseQuery({
    ...monitorQuery(id),
    refetchInterval: refresh.monitor,
  });
  const recent = useQuery({
    ...monitorRecentQuery(id),
    refetchInterval: refresh.recent,
  });
  const uptime = useQuery({
    ...monitorUptimeQuery(id),
    refetchInterval: refresh.uptime,
  });
  const checks = useQuery({
    ...monitorChecksQuery(id, monitorPageReads.checks),
    refetchInterval: refresh.checks,
  });
  const incidents = useQuery({
    ...monitorIncidentsQuery(id, monitorPageReads.incidentsLimit),
    refetchInterval: refresh.incidents,
  });
  return (
    <div {...stylex.props(styles.page)}>
      <MonitorHeader monitor={monitor} />
      <PageBanners monitor={monitor} />
      <StatCards monitor={monitor} recent={recent.data} uptime={uptime.data} />
      <UptimeCard uptime={uptime} />
      <LatencyCard recent={recent} />
      <HistoryTabs checks={checks} incidents={incidents} monitor={monitor} />
    </div>
  );
};
