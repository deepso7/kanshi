import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { colors, space } from "../theme/tokens.stylex.ts";
import type { BadgeVariant } from "./ui/badge.tsx";
import { Badge } from "./ui/badge.tsx";

/** A monitor's state, as the API reports it. */
export type MonitorStatus = "up" | "down" | "unknown" | "paused";

export const statusLabels = {
  down: "Down",
  paused: "Paused",
  unknown: "Unknown",
  up: "Up",
} satisfies Record<MonitorStatus, string>;

const badgeVariants = {
  down: "danger",
  paused: "unknown",
  unknown: "unknown",
  up: "success",
} satisfies Record<MonitorStatus, BadgeVariant>;

const ping = stylex.keyframes({
  "0%": { boxShadow: `0 0 0 0 ${colors.danger}` },
  "70%, 100%": { boxShadow: "0 0 0 5px transparent" },
});

const styles = stylex.create({
  badge: {
    gap: space.sm,
  },
  badgeDot: {
    height: "0.375rem",
    width: "0.375rem",
  },
  dot: {
    display: "inline-block",
    flexShrink: 0,
    height: "0.5rem",
    width: "0.5rem",
  },
  down: {
    animationDuration: "1.8s",
    animationIterationCount: "infinite",
    animationName: {
      "@media (prefers-reduced-motion: reduce)": "none",
      default: ping,
    },
    animationTimingFunction: "ease-out",
    backgroundColor: colors.danger,
  },
  // Two bars, like a pause glyph.
  paused: {
    backgroundImage: `linear-gradient(90deg, ${colors.unknown} 0 35%, transparent 35% 65%, ${colors.unknown} 65%)`,
  },
  sm: { height: "0.375rem", width: "0.375rem" },
  // Not checked yet: an empty frame.
  unknown: {
    borderColor: colors.unknown,
    borderStyle: "solid",
    borderWidth: "1px",
  },
  up: { backgroundColor: colors.success },
});

export type StatusDotProps = Omit<
  ComponentProps<"span">,
  "className" | "style" | "children"
> & {
  readonly status: MonitorStatus;
  readonly size?: "sm" | "md";
  /** Announced text; default the status name. Empty string: decorative. */
  readonly label?: string;
  readonly style?: stylex.StyleXStyles;
};

/** A small square in the status color (down pulses). */
export const StatusDot = ({
  label,
  size = "md",
  status,
  style,
  ...props
}: StatusDotProps) => {
  const text = label ?? statusLabels[status];
  return (
    <span
      aria-hidden={text === "" ? true : undefined}
      aria-label={text === "" ? undefined : text}
      data-status={status}
      role={text === "" ? undefined : "img"}
      {...props}
      {...stylex.props(
        styles.dot,
        size === "sm" && styles.sm,
        styles[status],
        style
      )}
    />
  );
};

export type StatusBadgeProps = Omit<
  ComponentProps<"span">,
  "className" | "style"
> & {
  readonly status: MonitorStatus;
  readonly style?: stylex.StyleXStyles;
};

/** The status as a tag: its dot and its name (or `children`). */
export const StatusBadge = ({
  children,
  status,
  style,
  ...props
}: StatusBadgeProps) => (
  <Badge
    data-status={status}
    variant={badgeVariants[status]}
    {...props}
    style={[styles.badge, style]}
  >
    <StatusDot label="" status={status} style={styles.badgeDot} />
    {children ?? statusLabels[status]}
  </Badge>
);
