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
  shadows,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";

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
  eyebrow: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
  },
  meta: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    margin: 0,
  },
  // The one colored element: the tone as a tag under the title.
  pill: {
    alignItems: "center",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "inline-flex",
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
    gap: space.sm,
    paddingBlock: space.xs,
    paddingInline: space.md,
  },
  // A small square in the tone's color, like the status dots.
  pillDot: {
    backgroundColor: "currentColor",
    flexShrink: 0,
    height: "0.5rem",
    width: "0.5rem",
  },
  // Neutral and centered: the title carries the message, not a fill.
  root: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.sm,
    color: colors.cardForeground,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    paddingBlock: { default: space.xxl, [media.md]: space.xxxl },
    paddingInline: space.lg,
    textAlign: "center",
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
  },
  title: {
    fontSize: { default: fontSizes.xxl, [media.md]: fontSizes.xxxl },
    fontWeight: fontWeights.medium,
    letterSpacing: "-0.01em",
    lineHeight: lineHeights.tight,
    margin: 0,
    textWrap: "balance",
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

/** The pill's word for each tone. */
const toneLabels = {
  danger: "Outage",
  success: "Operational",
  warning: "Degraded",
} satisfies Record<BannerTone, string>;

export interface StatusBannerProps {
  readonly overall: OverallStatus;
  readonly monitors: readonly { readonly status: PublicMonitorStatus }[];
  /** A small line under the summary ("Updated 12s ago"). */
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
      {...stylex.props(styles.root, style)}
    >
      <span {...stylex.props(styles.eyebrow)}>Current status</span>
      <h2 {...stylex.props(styles.title)}>{view.title}</h2>
      <span
        data-tone={view.tone}
        {...stylex.props(styles.pill, tones[view.tone])}
      >
        <span aria-hidden {...stylex.props(styles.pillDot)} />
        {toneLabels[view.tone]}
      </span>
      <div {...stylex.props(styles.text)}>
        <p {...stylex.props(styles.summary)}>{view.summary}</p>
        {meta === undefined ? null : (
          <p {...stylex.props(styles.meta)}>{meta}</p>
        )}
      </div>
    </section>
  );
};
