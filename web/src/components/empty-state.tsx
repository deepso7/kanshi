import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  lineHeights,
  radius,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  action: {
    marginTop: space.md,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    margin: 0,
    maxWidth: "28rem",
  },
  icon: {
    color: colors.mutedForeground,
    display: "flex",
    marginBottom: space.sm,
  },
  // A hollow square with a filled core: a "no signal" marker.
  marker: {
    "::after": {
      backgroundColor: colors.mutedForeground,
      content: '""',
      height: "0.375rem",
      width: "0.375rem",
    },
    alignItems: "center",
    borderColor: colors.mutedForeground,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    height: "1.5rem",
    justifyContent: "center",
    marginBottom: space.sm,
    width: "1.5rem",
  },
  root: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "dashed",
    borderWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingBlock: space.xxxl,
    paddingInline: space.xl,
    textAlign: "center",
  },
  title: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
});

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Replaces the default square marker. */
  readonly icon?: ReactNode;
  /** A button or link. */
  readonly action?: ReactNode;
  /** The title's heading element: `h1` when it is the whole page. */
  readonly heading?: "h1" | "h2" | "h3";
  readonly style?: stylex.StyleXStyles;
}

/** Nothing to show yet, and what to do about it. */
export const EmptyState = ({
  action,
  description,
  heading: Heading = "h3",
  icon,
  style,
  title,
}: EmptyStateProps) => (
  <div {...stylex.props(styles.root, style)}>
    {icon === undefined ? (
      <span aria-hidden {...stylex.props(styles.marker)} />
    ) : (
      <span aria-hidden {...stylex.props(styles.icon)}>
        {icon}
      </span>
    )}
    <Heading {...stylex.props(styles.title)}>{title}</Heading>
    {description === undefined ? null : (
      <p {...stylex.props(styles.description)}>{description}</p>
    )}
    {action === undefined ? null : (
      <div {...stylex.props(styles.action)}>{action}</div>
    )}
  </div>
);
