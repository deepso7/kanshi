import { Button as BaseButton } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  motion,
  radius,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

export type ButtonVariant =
  | "default"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "link";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const styles = stylex.create({
  base: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    cursor: { ":disabled": "not-allowed", default: "pointer" },
    display: "inline-flex",
    flexShrink: 0,
    fontFamily: "inherit",
    fontWeight: fontWeights.medium,
    gap: space.sm,
    justifyContent: "center",
    letterSpacing: tracking.wide,
    lineHeight: 1,
    opacity: { ":disabled": 0.5, ":is([data-disabled])": 0.5, default: 1 },
    textDecoration: "none",
    textTransform: "uppercase",
    transitionDuration: motion.fast,
    transitionProperty: "background-color, border-color, color",
    transitionTimingFunction: motion.ease,
    userSelect: "none",
    whiteSpace: "nowrap",
  },
});

const variants = stylex.create({
  default: {
    backgroundColor: {
      ":hover:not(:disabled)": colors.primaryHover,
      default: colors.primary,
    },
    color: colors.primaryForeground,
  },
  destructive: {
    backgroundColor: colors.destructive,
    color: colors.destructiveForeground,
    filter: { ":hover:not(:disabled)": "brightness(1.08)", default: "none" },
  },
  ghost: {
    backgroundColor: {
      ":hover:not(:disabled)": colors.accent,
      ":is([data-popup-open])": colors.accent,
      default: "transparent",
    },
    color: colors.foreground,
  },
  link: {
    backgroundColor: "transparent",
    color: colors.foreground,
    letterSpacing: tracking.normal,
    paddingInline: 0,
    textDecoration: { ":hover": "underline", default: "underline" },
    textDecorationColor: {
      ":hover": colors.foreground,
      default: colors.border,
    },
    textTransform: "none",
    textUnderlineOffset: "3px",
  },
  outline: {
    backgroundColor: {
      ":hover:not(:disabled)": colors.accent,
      default: "transparent",
    },
    borderColor: colors.input,
    color: colors.foreground,
  },
  secondary: {
    backgroundColor: {
      ":hover:not(:disabled)": colors.secondaryHover,
      default: colors.secondary,
    },
    borderColor: colors.border,
    color: colors.secondaryForeground,
  },
});

const sizes = stylex.create({
  icon: {
    height: "2.25rem",
    paddingInline: 0,
    width: "2.25rem",
  },
  lg: {
    fontSize: fontSizes.sm,
    height: "2.75rem",
    paddingInline: space.xl,
  },
  md: {
    fontSize: fontSizes.xs,
    height: "2.25rem",
    paddingInline: space.lg,
  },
  sm: {
    fontSize: fontSizes.xs,
    height: "1.75rem",
    paddingInline: space.sm,
  },
});

/** A link keeps its own size: no fixed height or padding. */
const linkSize = stylex.create({
  reset: { height: "auto", paddingInline: 0 },
});

export interface ButtonStyleProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** StyleX overrides, applied last. */
  readonly style?: stylex.StyleXStyles;
}

/**
 * The class names of a button, for elements that look like one without
 * being a `Button` (a router link, a Base UI trigger's `render`).
 */
export const buttonStyles = ({
  size = "md",
  style,
  variant = "default",
}: ButtonStyleProps) =>
  stylex.props(
    styles.base,
    shared.focusRing,
    variants[variant],
    sizes[size],
    variant === "link" && linkSize.reset,
    style
  );

export type ButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  "className" | "style"
> &
  ButtonStyleProps;

/**
 * A button (Base UI `Button`). `render` swaps the element but keeps button
 * semantics (`role="button"`, e.g. a `<span>` with `nativeButton={false}`);
 * for a link that looks like a button, spread `buttonStyles()` on the
 * router `<Link>` instead. `focusableWhenDisabled` keeps a disabled button
 * in the tab order.
 */
export const Button = ({ size, style, variant, ...props }: ButtonProps) => (
  <BaseButton {...props} {...buttonStyles({ size, style, variant })} />
);
