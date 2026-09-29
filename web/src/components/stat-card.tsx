import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  space,
} from "../theme/tokens.stylex.ts";
import { Card } from "./ui/card.tsx";
import { shared } from "./ui/shared.ts";

export type StatTone = "default" | "success" | "warning" | "danger" | "muted";

const styles = stylex.create({
  card: {
    gap: space.xs,
    padding: space.lg,
  },
  footer: {
    marginTop: space.sm,
  },
  hint: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    margin: 0,
  },
  unit: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
  },
  value: {
    alignItems: "baseline",
    display: "flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xxl,
    fontVariantNumeric: "tabular-nums",
    fontWeight: fontWeights.medium,
    gap: space.xs,
    lineHeight: lineHeights.tight,
    margin: 0,
  },
});

const tones = stylex.create({
  danger: { color: colors.dangerForeground },
  default: { color: colors.cardForeground },
  muted: { color: colors.mutedForeground },
  success: { color: colors.successForeground },
  warning: { color: colors.warningForeground },
});

export interface StatCardProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** After the value, smaller: "ms", "%". */
  readonly unit?: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: StatTone;
  /** Below: a sparkline or bars. */
  readonly children?: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/** A labelled figure (uptime, latency, open incidents). */
export const StatCard = ({
  children,
  hint,
  label,
  style,
  tone = "default",
  unit,
  value,
}: StatCardProps) => (
  <Card style={[styles.card, style]}>
    <span {...stylex.props(shared.label)}>{label}</span>
    <p {...stylex.props(styles.value, tones[tone])}>
      {value}
      {unit === undefined ? null : (
        <span {...stylex.props(styles.unit)}>{unit}</span>
      )}
    </p>
    {hint === undefined ? null : <p {...stylex.props(styles.hint)}>{hint}</p>}
    {children === undefined ? null : (
      <div {...stylex.props(styles.footer)}>{children}</div>
    )}
  </Card>
);
