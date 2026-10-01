import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { useMemo } from "react";

import { colors, motion, space } from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";
import { TooltipContent } from "./ui/tooltip.tsx";

/** One UTC day of history (the API's `UptimeDay` / `PublicDay` fit). */
export interface UptimeBarDay {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  /** Too few samples to trust the percentage. */
  readonly partial: boolean;
  readonly uptimePercent: number | null;
}

export type UptimeLevel = "up" | "degraded" | "down" | "partial" | "none";

/** At or above: a good day. */
export const upThreshold = 99.5;
/** At or above (and below `upThreshold`): degraded. Below: down. */
export const degradedThreshold = 95;

/**
 * A day's bar: `none` without samples (or before the monitor existed),
 * `partial` when there are too few to trust, else by uptime.
 */
export const uptimeLevel = (day: UptimeBarDay | null): UptimeLevel => {
  if (day === null || (day.uptimePercent === null && !day.partial)) {
    return "none";
  }
  if (day.partial || day.uptimePercent === null) {
    return "partial";
  }
  if (day.uptimePercent >= upThreshold) {
    return "up";
  }
  return day.uptimePercent >= degradedThreshold ? "degraded" : "down";
};

const formatPercent = (value: number) =>
  `${value >= 99.995 ? "100" : value.toFixed(2)}%`;

const describeDay = (day: UptimeBarDay | null): string => {
  if (day === null) {
    return "No data";
  }
  const percent =
    day.uptimePercent === null
      ? "no samples"
      : formatPercent(day.uptimePercent);
  return `${day.day}: ${percent}${day.partial ? " (partial)" : ""}`;
};

/** Oldest first, exactly `count` long: missing leading days are `null`. */
export const padDays = (
  days: readonly UptimeBarDay[],
  count: number
): readonly (UptimeBarDay | null)[] => {
  const recent = days.slice(-count);
  return [
    ...Array.from({ length: count - recent.length }, () => null),
    ...recent,
  ];
};

const styles = stylex.create({
  axis: {
    display: "flex",
    justifyContent: "space-between",
  },
  bar: {
    flexBasis: 0,
    flexGrow: 1,
    minWidth: "2px",
    opacity: { ":hover": 0.65, default: 1 },
    transitionDuration: motion.fast,
    transitionProperty: "opacity",
  },
  bars: {
    alignItems: "stretch",
    display: "flex",
    gap: "2px",
    height: "1.75rem",
  },
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    minWidth: 0,
  },
});

const levels = stylex.create({
  degraded: { backgroundColor: colors.warning },
  down: { backgroundColor: colors.danger },
  // The border gray: `muted` is the card's own color in the dark theme.
  none: { backgroundColor: colors.border },
  // The muted pattern: a hatch over the empty color.
  partial: {
    backgroundColor: colors.border,
    backgroundImage: `repeating-linear-gradient(135deg, ${colors.unknown} 0 1px, transparent 1px 4px)`,
  },
  up: { backgroundColor: colors.success },
});

export interface UptimeBarsProps {
  /** Oldest first; the last `count` are shown. */
  readonly days: readonly UptimeBarDay[];
  /** Bars to draw. Default 90. */
  readonly count?: number;
  /** Announced summary, e.g. "Uptime over 90 days: 99.9%". */
  readonly label: string;
  /** "90 days ago" / "Today" under the bars. Default shown. */
  readonly showAxis?: boolean;
  readonly style?: stylex.StyleXStyles;
}

/**
 * One bar per day, today on the right; hover a bar for its date and
 * uptime. Screen readers get `label`; the bars are hidden from them.
 */
export const UptimeBars = ({
  count = 90,
  days,
  label,
  showAxis = true,
  style,
}: UptimeBarsProps) => {
  const tooltip = useMemo(() => Tooltip.createHandle<string>(), []);
  const padded = padDays(days, count);
  return (
    <div {...stylex.props(styles.root, style)}>
      <span {...stylex.props(shared.srOnly)}>{label}</span>
      {/* Pointer-only detail; the summary above is what is announced. */}
      <div aria-hidden data-uptime-bars {...stylex.props(styles.bars)}>
        {padded.map((day, index) => {
          const level = uptimeLevel(day);
          return (
            <Tooltip.Trigger
              closeDelay={0}
              data-level={level}
              delay={0}
              handle={tooltip}
              // Days are unique and ordered; leading padding has no date.
              key={day?.day ?? `pad-${index}`}
              payload={describeDay(day)}
              render={<span />}
              {...stylex.props(styles.bar, levels[level])}
            />
          );
        })}
      </div>
      <Tooltip.Root handle={tooltip}>
        {({ payload }) => <TooltipContent>{payload}</TooltipContent>}
      </Tooltip.Root>
      {showAxis ? (
        <div aria-hidden {...stylex.props(styles.axis)}>
          <span {...stylex.props(shared.label)}>{count} days ago</span>
          <span {...stylex.props(shared.label)}>Today</span>
        </div>
      ) : null}
    </div>
  );
};

const legendStyles = stylex.create({
  item: {
    alignItems: "center",
    display: "inline-flex",
    gap: space.xs,
  },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.md,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  swatch: {
    height: "0.625rem",
    width: "0.625rem",
  },
});

const legendItems = [
  ["up", `≥ ${upThreshold}%`],
  ["degraded", `≥ ${degradedThreshold}%`],
  ["down", `< ${degradedThreshold}%`],
  ["partial", "Partial data"],
  ["none", "No data"],
] as const;

/** What the bar colors mean. */
export const UptimeLegend = ({
  style,
}: {
  readonly style?: stylex.StyleXStyles;
}) => (
  <ul {...stylex.props(legendStyles.legend, style)}>
    {legendItems.map(([level, text]) => (
      <li key={level} {...stylex.props(shared.label, legendStyles.item)}>
        <span {...stylex.props(legendStyles.swatch, levels[level])} />
        {text}
      </li>
    ))}
  </ul>
);
