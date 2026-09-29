import * as stylex from "@stylexjs/stylex";
import type { PointerEvent } from "react";
import { useState } from "react";

import { formatLatency } from "../lib/format.ts";
import {
  colors,
  fontSizes,
  fonts,
  radius,
  shadows,
  space,
} from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";

/** One time bucket (the API's `RecentBucket` fits). */
export interface LatencyBucket {
  /** Bucket start, epoch ms. */
  readonly at: number;
  /** Counted failures in the bucket. */
  readonly failures: number;
  /** Mean latency of the successful checks; null without any. */
  readonly latencyMs: number | null;
}

/** A round top for the y axis (its half stays whole): 1, 2 or 5 times a power of ten. */
export const niceCeiling = (value: number): number => {
  if (value <= 0) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((factor) => factor * power >= value);
  return (step ?? 10) * power;
};

const viewWidth = 1000;
const viewHeight = 100;

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Runs of consecutive samples (a null breaks the line). */
const runs = (
  buckets: readonly LatencyBucket[],
  top: number
): readonly (readonly Point[])[] => {
  const step = buckets.length > 1 ? viewWidth / (buckets.length - 1) : 0;
  const result: Point[][] = [];
  let current: Point[] = [];
  buckets.forEach((bucket, index) => {
    if (bucket.latencyMs === null) {
      if (current.length > 0) {
        result.push(current);
      }
      current = [];
      return;
    }
    current.push({
      x: buckets.length > 1 ? index * step : viewWidth / 2,
      y: viewHeight * (1 - bucket.latencyMs / top),
    });
  });
  if (current.length > 0) {
    result.push(current);
  }
  return result;
};

const line = (points: readonly Point[]) =>
  points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    )
    .join(" ");

const area = (points: readonly Point[]) => {
  const [first] = points;
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return "";
  }
  return `${line(points)} L${last.x.toFixed(1)} ${viewHeight} L${first.x.toFixed(1)} ${viewHeight} Z`;
};

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
});

const styles = stylex.create({
  area: {
    fill: colors.chart1,
    opacity: 0.12,
  },
  axisLabel: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    lineHeight: 1,
  },
  crosshair: {
    backgroundColor: colors.foreground,
    bottom: 0,
    opacity: 0.35,
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    width: "1px",
  },
  dot: {
    backgroundColor: colors.background,
    borderColor: colors.foreground,
    borderStyle: "solid",
    borderWidth: "2px",
    height: "0.5rem",
    pointerEvents: "none",
    position: "absolute",
    transform: "translate(-50%, -50%)",
    width: "0.5rem",
  },
  empty: {
    alignItems: "center",
    color: colors.mutedForeground,
    display: "flex",
    fontSize: fontSizes.sm,
    inset: 0,
    justifyContent: "center",
    position: "absolute",
  },
  failure: {
    backgroundColor: colors.danger,
  },
  failureCell: {
    flexBasis: 0,
    flexGrow: 1,
  },
  failureNone: {
    backgroundColor: colors.muted,
  },
  failures: {
    display: "flex",
    gap: "1px",
    height: "0.375rem",
  },
  grid: {
    borderTopColor: colors.border,
    borderTopStyle: "dashed",
    borderTopWidth: "1px",
    left: 0,
    position: "absolute",
    right: 0,
  },
  gridBase: {
    borderTopColor: colors.input,
    borderTopStyle: "solid",
  },
  line: {
    fill: "none",
    stroke: colors.chart1,
    strokeLinejoin: "round",
    strokeWidth: 2,
  },
  plot: {
    cursor: "crosshair",
    height: "9rem",
    position: "relative",
    touchAction: "pan-y",
  },
  plotColumn: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    minWidth: 0,
  },
  // A lone sample (its neighbours failed or had none): a square mark.
  point: {
    backgroundColor: colors.chart1,
    height: "0.3125rem",
    pointerEvents: "none",
    position: "absolute",
    transform: "translate(-50%, -50%)",
    width: "0.3125rem",
  },
  root: {
    columnGap: space.md,
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    rowGap: space.sm,
  },
  svg: {
    display: "block",
    height: "100%",
    inset: 0,
    overflow: "visible",
    position: "absolute",
    width: "100%",
  },
  tooltip: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    boxShadow: shadows.md,
    color: colors.primaryForeground,
    display: "flex",
    flexDirection: "column",
    fontSize: fontSizes.xs,
    gap: space.xxs,
    lineHeight: 1.4,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    pointerEvents: "none",
    position: "absolute",
    top: 0,
    whiteSpace: "nowrap",
  },
  tooltipValue: {
    fontFamily: fonts.mono,
  },
  xAxis: {
    display: "flex",
    gridColumn: 2,
    justifyContent: "space-between",
  },
  yAxis: {
    display: "flex",
    flexDirection: "column",
    height: "9rem",
    justifyContent: "space-between",
    textAlign: "end",
  },
  yLabelOffset: {
    transform: "translateY(-50%)",
  },
  yLabelOffsetBottom: {
    transform: "translateY(50%)",
  },
});

const dynamic = stylex.create({
  at: (left: string, top: string) => ({ left, top }),
  gridAt: (top: string) => ({ top }),
  left: (left: string) => ({ left }),
  tooltipAt: (left: string, shift: string) => ({
    left,
    transform: `translate(${shift}, calc(-100% - 0.5rem))`,
  }),
});

export interface LatencyChartProps {
  /** Oldest first, evenly spaced. */
  readonly buckets: readonly LatencyBucket[];
  /** Bucket length in ms (for the tooltip's range). */
  readonly bucketMs: number;
  /** Announced summary. */
  readonly label: string;
  /** Under the plot, left: "24h ago". */
  readonly startLabel: string;
}

const percent = (value: number) => `${(value * 100).toFixed(3)}%`;

/**
 * Mean latency per bucket (a line; gaps where nothing succeeded) over a
 * strip marking the buckets with failed checks. Hover or touch for a
 * bucket's values.
 */
export const LatencyChart = ({
  bucketMs,
  buckets,
  label,
  startLabel,
}: LatencyChartProps) => {
  const [active, setActive] = useState<number | null>(null);
  const known = buckets.flatMap((bucket) =>
    bucket.latencyMs === null ? [] : [bucket.latencyMs]
  );
  // At least 10 ms, so a fast target does not look jittery at 1 ms steps.
  const top = niceCeiling(Math.max(10, ...known) * 1.1);
  const segments = runs(buckets, top);
  const count = buckets.length;
  const xOf = (index: number) => (count > 1 ? index / (count - 1) : 0.5);

  const onPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientX - box.left) / box.width)
    );
    setActive(count === 0 ? null : Math.round(ratio * (count - 1)));
  };

  const current = active === null ? undefined : buckets[active];
  const ticks = [1, 0.5, 0];

  return (
    <div {...stylex.props(styles.root)}>
      <span {...stylex.props(shared.srOnly)}>{label}</span>
      <div aria-hidden {...stylex.props(styles.yAxis)}>
        {ticks.map((tick, index) => (
          <span
            key={tick}
            {...stylex.props(
              styles.axisLabel,
              index === 0 && styles.yLabelOffset,
              index === ticks.length - 1 && styles.yLabelOffsetBottom
            )}
          >
            {formatLatency(top * tick)}
          </span>
        ))}
      </div>
      <div aria-hidden {...stylex.props(styles.plotColumn)}>
        <div
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
          onPointerMove={onPointer}
          {...stylex.props(styles.plot)}
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              {...stylex.props(
                styles.grid,
                tick === 0 && styles.gridBase,
                dynamic.gridAt(percent(1 - tick))
              )}
            />
          ))}
          <svg
            preserveAspectRatio="none"
            viewBox={`0 0 ${viewWidth} ${viewHeight}`}
            {...stylex.props(styles.svg)}
          >
            {segments.map((points) => (
              <g key={points[0]?.x ?? 0}>
                <path d={area(points)} {...stylex.props(styles.area)} />
                <path
                  d={line(points)}
                  vectorEffect="non-scaling-stroke"
                  {...stylex.props(styles.line)}
                />
              </g>
            ))}
          </svg>
          {segments
            .filter((points) => points.length === 1)
            .map(([point]) =>
              point === undefined ? null : (
                <span
                  key={point.x}
                  {...stylex.props(
                    styles.point,
                    dynamic.at(
                      percent(point.x / viewWidth),
                      percent(point.y / viewHeight)
                    )
                  )}
                />
              )
            )}
          {known.length === 0 ? (
            <span {...stylex.props(styles.empty)}>
              No successful checks in this window
            </span>
          ) : null}
          {active === null || current === undefined ? null : (
            <>
              <span
                {...stylex.props(
                  styles.crosshair,
                  dynamic.left(percent(xOf(active)))
                )}
              />
              {current.latencyMs === null ? null : (
                <span
                  {...stylex.props(
                    styles.dot,
                    dynamic.at(
                      percent(xOf(active)),
                      percent(1 - current.latencyMs / top)
                    )
                  )}
                />
              )}
              <span
                {...stylex.props(
                  styles.tooltip,
                  dynamic.tooltipAt(
                    percent(xOf(active)),
                    `${(-xOf(active) * 100).toFixed(1)}%`
                  )
                )}
              >
                <span>
                  {time.format(current.at)} –{" "}
                  {time.format(current.at + bucketMs)}
                </span>
                <span {...stylex.props(styles.tooltipValue)}>
                  {current.latencyMs === null
                    ? "No successful check"
                    : `${formatLatency(current.latencyMs)} mean`}
                </span>
                {current.failures > 0 ? (
                  <span {...stylex.props(styles.tooltipValue)}>
                    {current.failures} failed{" "}
                    {current.failures === 1 ? "check" : "checks"}
                  </span>
                ) : null}
              </span>
            </>
          )}
        </div>
        <div {...stylex.props(styles.failures)}>
          {buckets.map((bucket) => (
            <span
              key={bucket.at}
              {...stylex.props(
                styles.failureCell,
                bucket.failures > 0 ? styles.failure : styles.failureNone
              )}
            />
          ))}
        </div>
      </div>
      <div aria-hidden {...stylex.props(styles.xAxis)}>
        <span {...stylex.props(shared.label)}>{startLabel}</span>
        <span {...stylex.props(shared.label)}>Now</span>
      </div>
    </div>
  );
};
