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

export type CalloutTone = "info" | "warning" | "danger";

const styles = stylex.create({
  action: {
    alignSelf: { "@media (min-width: 640px)": "center", default: "flex-start" },
    flexShrink: 0,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space.xxs,
    minWidth: 0,
  },
  description: {
    color: colors.foreground,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  marker: {
    flexShrink: 0,
    height: "0.5rem",
    marginTop: "0.3125rem",
    width: "0.5rem",
  },
  root: {
    alignItems: "flex-start",
    borderLeftWidth: "3px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    flexDirection: { "@media (min-width: 640px)": "row", default: "column" },
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
  },
  row: {
    alignItems: "flex-start",
    display: "flex",
    flexGrow: 1,
    gap: space.md,
    minWidth: 0,
  },
  title: {
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.normal,
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
  info: {
    backgroundColor: colors.muted,
    borderColor: colors.border,
    borderLeftColor: colors.foreground,
    color: colors.foreground,
  },
  warning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
    color: colors.warningForeground,
  },
});

const markers = stylex.create({
  danger: { backgroundColor: colors.danger },
  info: { backgroundColor: colors.foreground },
  warning: { backgroundColor: colors.warning },
});

export interface CalloutProps {
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly tone?: CalloutTone;
  /** A button or link, at the end. */
  readonly action?: ReactNode;
  /** `alert` for something that needs attention now; default `note`. */
  readonly role?: "alert" | "note" | "status";
  readonly style?: stylex.StyleXStyles;
}

/** A banner in a page: a state to know about (managed, paused, stale). */
export const Callout = ({
  action,
  children,
  role = "note",
  style,
  title,
  tone = "info",
}: CalloutProps) => (
  <div role={role} {...stylex.props(styles.root, tones[tone], style)}>
    <div {...stylex.props(styles.row)}>
      <span aria-hidden {...stylex.props(styles.marker, markers[tone])} />
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.title)}>{title}</p>
        {children === undefined ? null : (
          <p {...stylex.props(styles.description)}>{children}</p>
        )}
      </div>
    </div>
    {action === undefined ? null : (
      <div {...stylex.props(styles.action)}>{action}</div>
    )}
  </div>
);
