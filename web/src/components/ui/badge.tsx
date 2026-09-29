import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  radius,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "destructive"
  | "success"
  | "warning"
  | "danger"
  | "unknown";

const styles = stylex.create({
  base: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.sm,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    gap: "0.375rem",
    height: "1.25rem",
    letterSpacing: tracking.wide,
    lineHeight: 1,
    paddingInline: space.sm,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
});

const variants = stylex.create({
  danger: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    color: colors.dangerForeground,
  },
  default: {
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  destructive: {
    backgroundColor: colors.destructive,
    color: colors.destructiveForeground,
  },
  outline: {
    borderColor: colors.input,
    color: colors.foreground,
  },
  secondary: {
    backgroundColor: colors.secondary,
    color: colors.secondaryForeground,
  },
  success: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.successForeground,
  },
  unknown: {
    backgroundColor: colors.unknownSurface,
    borderColor: colors.unknown,
    color: colors.unknownForeground,
  },
  warning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
    color: colors.warningForeground,
  },
});

export type BadgeProps = Omit<ComponentProps<"span">, "className" | "style"> & {
  readonly variant?: BadgeVariant;
  readonly style?: stylex.StyleXStyles;
};

/** A small uppercase tag; status variants use the status surfaces. */
export const Badge = ({ style, variant = "default", ...props }: BadgeProps) => (
  <span {...props} {...stylex.props(styles.base, variants[variant], style)} />
);
