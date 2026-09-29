import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type {
  OverallStatus,
  PublicMonitorStatus,
} from "../../../src/domain/public-status.ts";
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
import { shared } from "./ui/shared.ts";

export type BannerTone = "success" | "warning" | "danger";

export interface StatusBannerView {
  readonly title: string;
  readonly tone: BannerTone;
  /** How many monitors are down, up or paused, in words. */
  readonly summary: string;
}

const overallViews = {
  major_outage: { title: "Major outage", tone: "danger" },
  operational: { title: "All systems operational", tone: "success" },
  partial_outage: { title: "Partial outage", tone: "warning" },
} satisfies Record<OverallStatus, { title: string; tone: BannerTone }>;

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The status page's headline: the API's overall status as a title and a
 * tone, and a count of the monitors behind it (paused ones are not
 * watched, so they count for neither side).
 */
export const statusBannerView = (
  overall: OverallStatus,
  monitors: readonly { readonly status: PublicMonitorStatus }[]
): StatusBannerView => {
  const paused = monitors.filter((m) => m.status === "paused").length;
  const watched = monitors.length - paused;
  const down = monitors.filter((m) => m.status === "down").length;
  let summary: string;
  if (monitors.length === 0) {
    summary = "No monitors are published yet";
  } else if (watched === 0) {
    summary = `${plural(paused, "monitor")}, all paused`;
  } else {
    summary =
      down === 0
        ? `${plural(watched, "monitor")}, none down`
        : `${down} of ${plural(watched, "monitor")} down`;
    if (paused > 0) {
      summary += ` · ${paused} paused`;
    }
  }
  return { ...overallViews[overall], summary };
};

const styles = stylex.create({
  // The status square, framed: a filled core in the tone's color.
  mark: {
    "::after": {
      backgroundColor: "currentColor",
      content: '""',
      flexGrow: 1,
    },
    borderColor: "currentColor",
    borderStyle: "solid",
    borderWidth: "2px",
    display: "inline-flex",
    flexShrink: 0,
    height: { default: "1.5rem", [media.md]: "1.875rem" },
    padding: "3px",
    width: { default: "1.5rem", [media.md]: "1.875rem" },
  },
  meta: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
  root: {
    alignItems: "center",
    borderLeftWidth: "4px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    gap: { default: space.lg, [media.md]: space.xl },
    paddingBlock: { default: space.lg, [media.md]: space.xl },
    paddingInline: { default: space.lg, [media.md]: space.xl },
  },
  summary: {
    color: colors.foreground,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    minWidth: 0,
  },
  title: {
    fontSize: { default: fontSizes.xl, [media.md]: fontSizes.xxl },
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.tight,
    margin: 0,
    textTransform: "uppercase",
  },
});

const tones = stylex.create({
  danger: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    color: colors.dangerForeground,
  },
  success: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.successForeground,
  },
  warning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
    color: colors.warningForeground,
  },
});

export interface StatusBannerProps {
  readonly overall: OverallStatus;
  readonly monitors: readonly { readonly status: PublicMonitorStatus }[];
  /** A small mono line under the summary ("Updated 12s ago"). */
  readonly meta?: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/** The overall status, large: operational, partial or major outage. */
export const StatusBanner = ({
  meta,
  monitors,
  overall,
  style,
}: StatusBannerProps) => {
  const view = statusBannerView(overall, monitors);
  return (
    <section
      aria-label="Overall status"
      data-overall={overall}
      {...stylex.props(styles.root, tones[view.tone], style)}
    >
      <span aria-hidden {...stylex.props(styles.mark)} />
      <div {...stylex.props(styles.text)}>
        <span {...stylex.props(shared.label)}>System status</span>
        <h2 {...stylex.props(styles.title)}>{view.title}</h2>
        <p {...stylex.props(styles.summary)}>{view.summary}</p>
        {meta === undefined ? null : (
          <p {...stylex.props(styles.meta)}>{meta}</p>
        )}
      </div>
    </section>
  );
};
