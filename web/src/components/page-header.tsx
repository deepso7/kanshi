import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  lineHeights,
  media,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";

const styles = stylex.create({
  actions: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    flexWrap: "wrap",
    gap: space.sm,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    margin: 0,
    maxWidth: "48rem",
  },
  root: {
    // A short heavy segment on the rule, under the title.
    "::after": {
      backgroundColor: colors.foreground,
      bottom: "-1px",
      content: '""',
      height: "3px",
      left: 0,
      position: "absolute",
      width: "3rem",
    },
    alignItems: { default: "stretch", [media.md]: "flex-end" },
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    display: "flex",
    flexDirection: { default: "column", [media.md]: "row" },
    gap: space.lg,
    justifyContent: "space-between",
    marginBottom: space.xl,
    paddingBottom: space.lg,
    position: "relative",
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    minWidth: 0,
  },
  title: {
    "::before": {
      backgroundColor: "currentColor",
      content: '""',
      flexShrink: 0,
      height: "0.625rem",
      width: "0.625rem",
    },
    alignItems: "center",
    display: "flex",
    fontSize: fontSizes.xxl,
    fontWeight: fontWeights.semibold,
    gap: space.md,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.tight,
    margin: 0,
    textTransform: "uppercase",
  },
});

export interface PageHeaderProps {
  readonly title: ReactNode;
  /** Small uppercase line above the title (a section, a breadcrumb). */
  readonly eyebrow?: ReactNode;
  readonly description?: ReactNode;
  /** Buttons, on the right (below on small screens). */
  readonly actions?: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/** A page's `h1`, its context and its actions. */
export const PageHeader = ({
  actions,
  description,
  eyebrow,
  style,
  title,
}: PageHeaderProps) => (
  <header {...stylex.props(styles.root, style)}>
    <div {...stylex.props(styles.text)}>
      {eyebrow === undefined ? null : (
        <span {...stylex.props(shared.label)}>{eyebrow}</span>
      )}
      <h1 {...stylex.props(styles.title)}>{title}</h1>
      {description === undefined ? null : (
        <p {...stylex.props(styles.description)}>{description}</p>
      )}
    </div>
    {actions === undefined ? null : (
      <div {...stylex.props(styles.actions)}>{actions}</div>
    )}
  </header>
);
