// Dev-only (`/_ui`): every design-system component, in the light and the
// dark theme side by side. Overlays (dialogs, menus, tooltips, toasts)
// render in a portal and follow the page theme (the toggle at the top).
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { useState } from "react";

import { AppShell, AppShellNavLink } from "../components/app-shell.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { Sparkline } from "../components/sparkline.tsx";
import { StatCard } from "../components/stat-card.tsx";
import type { MonitorStatus } from "../components/status.tsx";
import { StatusBadge, StatusDot } from "../components/status.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
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
import type { ButtonSize, ButtonVariant } from "../components/ui/button.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { FormField } from "../components/ui/field.tsx";
import { MoreIcon, PlusIcon } from "../components/ui/icons.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../components/ui/select.tsx";
import { Separator } from "../components/ui/separator.tsx";
import { shared } from "../components/ui/shared.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Switch } from "../components/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCaption,
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
import { Textarea } from "../components/ui/textarea.tsx";
import { toast } from "../components/ui/toast.tsx";
import { SimpleTooltip } from "../components/ui/tooltip.tsx";
import type { UptimeBarDay } from "../components/uptime-bars.tsx";
import { UptimeBars, UptimeLegend } from "../components/uptime-bars.tsx";
import type { ResolvedTheme } from "../theme/themes.ts";
import { themes } from "../theme/themes.ts";
import {
  colors,
  fontSizes,
  fonts,
  radius,
  space,
} from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  chip: {
    borderColor: colors.border,
    borderStyle: "solid",
    borderWidth: "1px",
    flexShrink: 0,
    height: "1.25rem",
    width: "1.25rem",
  },
  form: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
  },
  grid: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  },
  inline: {
    alignItems: "center",
    display: "flex",
    gap: space.sm,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
  },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    marginInline: "auto",
    maxWidth: "80rem",
    padding: space.xl,
  },
  panel: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderStyle: "solid",
    borderWidth: "1px",
    color: colors.foreground,
    display: "flex",
    flexDirection: "column",
    fontSize: fontSizes.md,
    gap: space.xxl,
    padding: space.xl,
  },
  row: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  shellFrame: {
    borderColor: colors.border,
    borderStyle: "solid",
    borderWidth: "1px",
    height: "26rem",
    overflow: "hidden",
  },
  shellInner: {
    height: "100%",
    minHeight: 0,
  },
  skeletonBlock: { height: "3rem", width: "100%" },
  skeletonRow: { height: "0.75rem", width: "60%" },
  swatch: {
    alignItems: "center",
    display: "flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gap: space.sm,
  },
  swatches: {
    display: "grid",
    gap: space.sm,
    gridTemplateColumns: "repeat(auto-fill, minmax(9rem, 1fr))",
  },
  toolbar: {
    alignItems: "center",
    display: "flex",
    gap: space.md,
  },
  vertical: { height: "1.5rem" },
});

const swatchColors = stylex.create({
  accent: { backgroundColor: colors.accent },
  background: { backgroundColor: colors.background },
  border: { backgroundColor: colors.border },
  card: { backgroundColor: colors.card },
  chart1: { backgroundColor: colors.chart1 },
  chart2: { backgroundColor: colors.chart2 },
  chart3: { backgroundColor: colors.chart3 },
  chart4: { backgroundColor: colors.chart4 },
  chart5: { backgroundColor: colors.chart5 },
  danger: { backgroundColor: colors.danger },
  destructive: { backgroundColor: colors.destructive },
  muted: { backgroundColor: colors.muted },
  popover: { backgroundColor: colors.popover },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.secondary },
  sidebar: { backgroundColor: colors.sidebar },
  success: { backgroundColor: colors.success },
  unknown: { backgroundColor: colors.unknown },
  warning: { backgroundColor: colors.warning },
});

const swatchNames = [
  "background",
  "card",
  "popover",
  "primary",
  "secondary",
  "muted",
  "accent",
  "destructive",
  "border",
  "sidebar",
  "success",
  "warning",
  "danger",
  "unknown",
  "chart1",
  "chart2",
  "chart3",
  "chart4",
  "chart5",
] as const satisfies readonly (keyof typeof swatchColors)[];

const buttonVariants: readonly ButtonVariant[] = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
];
const buttonSizes: readonly Exclude<ButtonSize, "icon">[] = ["sm", "md", "lg"];
const badgeVariants: readonly BadgeVariant[] = [
  "default",
  "secondary",
  "outline",
  "destructive",
  "success",
  "warning",
  "danger",
  "unknown",
];
const statuses: readonly MonitorStatus[] = ["up", "down", "unknown", "paused"];

/** 80 days of a young monitor: mostly up, a few bad and partial days. */
const sampleDays: readonly UptimeBarDay[] = Array.from(
  { length: 80 },
  (_, index) => {
    const date = new Date(Date.UTC(2026, 6, 12 + index));
    const special = new Map<number, Omit<UptimeBarDay, "day">>([
      [0, { partial: true, uptimePercent: 100 }],
      [23, { partial: false, uptimePercent: 97.4 }],
      [24, { partial: false, uptimePercent: 99.1 }],
      [51, { partial: false, uptimePercent: 82.3 }],
      [60, { partial: true, uptimePercent: null }],
      [79, { partial: true, uptimePercent: 100 }],
    ]);
    return {
      day: date.toISOString().slice(0, 10),
      ...(special.get(index) ?? { partial: false, uptimePercent: 100 }),
    };
  }
);

/** 48 latency samples (ms) with a gap and a spike. */
const sampleLatency: readonly (number | null)[] = Array.from(
  { length: 48 },
  (_, index) => {
    if (index === 30 || index === 31) {
      return null;
    }
    return Math.round(
      140 + 30 * Math.sin(index / 3) + (index === 20 ? 260 : 0)
    );
  }
);

const sampleMonitors = [
  { latency: 142, name: "api.example.com", status: "up", uptime: "99.98%" },
  {
    latency: 611,
    name: "status.example.com",
    status: "down",
    uptime: "97.12%",
  },
  { latency: null, name: "new-service", status: "unknown", uptime: "—" },
  { latency: null, name: "legacy-cron", status: "paused", uptime: "100%" },
] as const;

const Section = ({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) => (
  <section {...stylex.props(styles.section)}>
    <h2 {...stylex.props(shared.label)}>[ {title} ]</h2>
    {children}
  </section>
);

const Buttons = () => (
  <Section title="Button">
    <div {...stylex.props(styles.row)}>
      {buttonVariants.map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
    </div>
    <div {...stylex.props(styles.row)}>
      {buttonSizes.map((size) => (
        <Button key={size} size={size} variant="outline">
          Size {size}
        </Button>
      ))}
      <SimpleTooltip content="Add a monitor">
        <Button aria-label="Add a monitor" size="icon">
          <PlusIcon />
        </Button>
      </SimpleTooltip>
      <Button disabled>Disabled</Button>
      <Button>
        <PlusIcon /> With icon
      </Button>
    </div>
  </Section>
);

const Badges = () => (
  <Section title="Badge and status">
    <div {...stylex.props(styles.row)}>
      {badgeVariants.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
    <div {...stylex.props(styles.row)}>
      {statuses.map((status) => (
        <StatusBadge key={status} status={status} />
      ))}
      {statuses.map((status) => (
        <StatusDot key={status} status={status} />
      ))}
    </div>
  </Section>
);

const FormControls = () => {
  const [enabled, setEnabled] = useState(true);
  return (
    <Section title="Form">
      <div {...stylex.props(styles.form)}>
        <FormField description="Shown on the status page." label="Name">
          <Input placeholder="API" />
        </FormField>
        <FormField error="Enter an http(s) URL." label="URL">
          <Input defaultValue="ftp://example.com" mono />
        </FormField>
        <FormField label="Interval">
          <Select
            defaultValue="60"
            items={{ "30": "30 seconds", "300": "5 minutes", "60": "1 minute" }}
          >
            <SelectTrigger />
            <SelectContent>
              <SelectItem value="30">30 seconds</SelectItem>
              <SelectItem value="60">1 minute</SelectItem>
              <SelectItem value="300">5 minutes</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField description="One per line." label="Notes">
          <Textarea placeholder="Anything the on-call should know" />
        </FormField>
        <div {...stylex.props(styles.section)}>
          <Label htmlFor="showcase-standalone">Standalone label</Label>
          <Input id="showcase-standalone" placeholder="Disabled" disabled />
        </div>
        <div {...stylex.props(styles.section)}>
          <span {...stylex.props(styles.inline)}>
            <Checkbox aria-label="Public" defaultChecked />
            Public
          </span>
          <span {...stylex.props(styles.inline)}>
            <Checkbox aria-label="Some channels" indeterminate />
            Some channels
          </span>
          <span {...stylex.props(styles.inline)}>
            <Switch
              aria-label="Alerts"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            Alerts {enabled ? "on" : "off"}
          </span>
          <span {...stylex.props(styles.inline)}>
            <Switch aria-label="Disabled switch" disabled />
            Disabled
          </span>
        </div>
      </div>
    </Section>
  );
};

const Cards = () => (
  <Section title="Card, stat card, sparkline">
    <div {...stylex.props(styles.grid)}>
      <StatCard
        hint="Last 90 days"
        label="Uptime"
        tone="success"
        unit="%"
        value="99.98"
      />
      <StatCard label="Latency p95" unit="ms" value="212">
        <Sparkline label="Latency over 24 hours" values={sampleLatency} />
      </StatCard>
      <StatCard
        hint="Since 12:04 UTC"
        label="Open incidents"
        tone="danger"
        value="1"
      />
      <StatCard label="Paused" tone="muted" value="0" />
    </div>
    <Card>
      <CardHeader>
        <CardTitle>api.example.com</CardTitle>
        <CardDescription>
          GET https://api.example.com/health, every minute
        </CardDescription>
        <CardAction>
          <StatusBadge status="up" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <UptimeBars days={sampleDays} label="Uptime over 90 days: 99.6%" />
      </CardContent>
      <CardFooter>
        <UptimeLegend />
      </CardFooter>
    </Card>
    <div {...stylex.props(styles.grid)}>
      <Sparkline label="Latency" values={sampleLatency} />
      <Sparkline
        area={false}
        label="Latency"
        tone="danger"
        values={sampleLatency}
      />
      <Sparkline label="No samples" values={[]} />
    </div>
  </Section>
);

const MonitorsTable = () => (
  <Section title="Table">
    <Table>
      <TableCaption>Four monitors.</TableCaption>
      <TableHeader>
        <TableRow header>
          <TableHead>Monitor</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Uptime</TableHead>
          <TableHead>Latency</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sampleMonitors.map((monitor) => (
          <TableRow key={monitor.name}>
            <TableCell style={styles.mono}>{monitor.name}</TableCell>
            <TableCell>
              <StatusBadge status={monitor.status} />
            </TableCell>
            <TableCell style={styles.mono}>{monitor.uptime}</TableCell>
            <TableCell style={styles.mono}>
              {monitor.latency === null ? "—" : `${monitor.latency} ms`}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </Section>
);

const Overlays = () => (
  <Section title="Dialog, menu, tooltip, toast">
    <div {...stylex.props(styles.row)}>
      <Dialog>
        <DialogTrigger render={<Button variant="outline" />}>
          Open dialog
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit monitor</DialogTitle>
            <DialogDescription>
              Changes apply from the next check.
            </DialogDescription>
          </DialogHeader>
          <FormField label="Name">
            <Input defaultValue="API" />
          </FormField>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <DialogClose render={<Button />}>Save</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="destructive" />}>
          Delete monitor
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete api.example.com?</AlertDialogTitle>
            <AlertDialogDescription>
              Its history and incidents are deleted too. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Monitor actions"
          render={<Button size="icon" variant="ghost" />}
        >
          <MoreIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Monitor</DropdownMenuLabel>
            <DropdownMenuItem>
              Edit <DropdownMenuShortcut>E</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>Pause</DropdownMenuItem>
            <DropdownMenuItem disabled>Check now</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SimpleTooltip content="Checked 12 seconds ago">
        <Button variant="secondary">Hover me</Button>
      </SimpleTooltip>
      <Button onClick={() => toast("Monitor saved")} variant="outline">
        Toast
      </Button>
      <Button
        onClick={() =>
          toast.success("Back up", {
            description: "api.example.com after 4 minutes.",
          })
        }
        variant="outline"
      >
        Success toast
      </Button>
      <Button
        onClick={() =>
          toast.error("Could not save", {
            description: "The URL is not valid.",
          })
        }
        variant="outline"
      >
        Error toast
      </Button>
    </div>
  </Section>
);

const TabsAndMore = () => (
  <Section title="Tabs, skeleton, separator">
    <Tabs defaultValue="overview">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="incidents">Incidents</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger disabled value="logs">
          Logs
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <div {...stylex.props(styles.section)}>
          <Skeleton style={styles.skeletonRow} />
          <Skeleton style={styles.skeletonBlock} />
        </div>
      </TabsContent>
      <TabsContent value="incidents">
        <EmptyState
          action={<Button variant="outline">View history</Button>}
          description="No incident in the last 90 days."
          title="All clear"
        />
      </TabsContent>
      <TabsContent value="settings">Settings go here.</TabsContent>
    </Tabs>
    <Separator />
    <div {...stylex.props(styles.row)}>
      <span>Left</span>
      <Separator orientation="vertical" style={styles.vertical} />
      <span>Right</span>
    </div>
  </Section>
);

const Layout = () => (
  <Section title="Page header, app shell">
    <PageHeader
      actions={
        <>
          <Button variant="outline">Sync</Button>
          <Button>
            <PlusIcon /> New monitor
          </Button>
        </>
      }
      description="Everything Kanshi watches, and how it is doing."
      eyebrow="Dashboard"
      title="Monitors"
    />
    <div {...stylex.props(styles.shellFrame)}>
      <AppShell
        footer={
          <>
            <ThemeToggle />
            <Button size="sm" variant="ghost">
              Sign out
            </Button>
          </>
        }
        nav={
          <>
            <AppShellNavLink active href="#monitors">
              Monitors
            </AppShellNavLink>
            <AppShellNavLink href="#channels">Channels</AppShellNavLink>
            <AppShellNavLink href="#status">Status page</AppShellNavLink>
          </>
        }
        style={styles.shellInner}
      >
        <PageHeader eyebrow="Overview" title="Monitors" />
        <EmptyState
          action={<Button>Add a monitor</Button>}
          description="Add a URL to watch."
          title="No monitors yet"
        />
      </AppShell>
    </div>
  </Section>
);

const Palette = () => (
  <Section title="Colors">
    <div {...stylex.props(styles.swatches)}>
      {swatchNames.map((name) => (
        <span key={name} {...stylex.props(styles.swatch)}>
          <span {...stylex.props(styles.chip, swatchColors[name])} />
          {name}
        </span>
      ))}
    </div>
  </Section>
);

const Gallery = ({ theme }: { readonly theme: ResolvedTheme }) => (
  <div {...stylex.props(themes[theme], styles.panel)}>
    <PageHeader eyebrow="Theme" title={theme} />
    <Palette />
    <Buttons />
    <Badges />
    <FormControls />
    <Cards />
    <MonitorsTable />
    <Overlays />
    <TabsAndMore />
    <Layout />
  </div>
);

export const UiShowcase = () => (
  <div {...stylex.props(styles.page)}>
    <div {...stylex.props(styles.toolbar)}>
      <span {...stylex.props(shared.label)}>
        Page theme (portals follow it)
      </span>
      <ThemeToggle />
    </div>
    <Gallery theme="light" />
    <Gallery theme="dark" />
  </div>
);
