import * as stylex from "@stylexjs/stylex";

import { colors } from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";

export type SparklineTone = "default" | "success" | "warning" | "danger";

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * The runs of consecutive values, as points in a `width` x `height` box
 * (y grows down, `pad` keeps the stroke inside). A `null` breaks the line.
 */
export const sparklineSegments = (
  values: readonly (number | null)[],
  width: number,
  height: number,
  pad = 2
): readonly (readonly Point[])[] => {
  const known = values.filter((value) => value !== null);
  if (known.length === 0) {
    return [];
  }
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const segments: Point[][] = [];
  let current: Point[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) {
        segments.push(current);
      }
      current = [];
      return;
    }
    current.push({
      x: values.length > 1 ? index * step : width / 2,
      y: pad + (1 - (value - min) / span) * (height - 2 * pad),
    });
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
};

const round = (value: number) => Math.round(value * 100) / 100;

const linePath = (points: readonly Point[]) =>
  points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`
    )
    .join(" ");

/**
 * A lone point as a zero-length line: its round cap draws a dot that stays
 * round under `preserveAspectRatio="none"` (a circle would be stretched).
 */
const dotPath = (point: Point) => `M${round(point.x)} ${round(point.y)}h0`;

const areaPath = (points: readonly Point[], height: number) => {
  const [first] = points;
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return "";
  }
  return `${linePath(points)} L${round(last.x)} ${height} L${round(first.x)} ${height} Z`;
};

const styles = stylex.create({
  area: {
    opacity: 0.14,
    stroke: "none",
  },
  dot: {
    fill: "none",
    strokeLinecap: "round",
    strokeWidth: 3,
  },
  empty: {
    stroke: colors.border,
    strokeDasharray: "2 3",
    strokeWidth: 1,
  },
  line: {
    fill: "none",
    strokeLinejoin: "round",
    strokeWidth: 1.25,
  },
  root: {
    display: "block",
    height: "2rem",
    position: "relative",
    width: "100%",
  },
  svg: {
    display: "block",
    height: "100%",
    overflow: "visible",
    width: "100%",
  },
});

const tones = stylex.create({
  danger: { fill: colors.danger, stroke: colors.danger },
  default: { fill: colors.chart1, stroke: colors.chart1 },
  success: { fill: colors.success, stroke: colors.success },
  warning: { fill: colors.warning, stroke: colors.warning },
});

/** A run of points: a line (and its area), or a dot for a lone point. */
const SparklineSegment = ({
  area,
  height,
  points,
}: {
  readonly area: boolean;
  readonly height: number;
  readonly points: readonly Point[];
}) => {
  const [first] = points;
  if (first === undefined) {
    return null;
  }
  if (points.length === 1) {
    return (
      <path
        d={dotPath(first)}
        data-sparkline-dot=""
        vectorEffect="non-scaling-stroke"
        {...stylex.props(styles.dot)}
      />
    );
  }
  return (
    <g>
      {area ? (
        <path d={areaPath(points, height)} {...stylex.props(styles.area)} />
      ) : null}
      <path
        d={linePath(points)}
        vectorEffect="non-scaling-stroke"
        {...stylex.props(styles.line)}
      />
    </g>
  );
};

export interface SparklineProps {
  /** Oldest first; `null` for a gap (no sample). */
  readonly values: readonly (number | null)[];
  /** Announced description, e.g. "Latency, last 24 hours: 120 to 340 ms". */
  readonly label: string;
  readonly tone?: SparklineTone;
  /** Fill under the line. Default on. */
  readonly area?: boolean;
  /** Size of the drawing box; the SVG stretches to its CSS size. */
  readonly width?: number;
  readonly height?: number;
  /** Size (height, width) overrides, on the wrapper. */
  readonly style?: stylex.StyleXStyles;
}

/** A small latency line (SVG); scales with its container. */
export const Sparkline = ({
  area = true,
  height = 32,
  label,
  style,
  tone = "default",
  values,
  width = 120,
}: SparklineProps) => {
  const segments = sparklineSegments(values, width, height);
  return (
    <span {...stylex.props(styles.root, style)}>
      <span {...stylex.props(shared.srOnly)}>{label}</span>
      <svg
        aria-hidden
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
        {...stylex.props(styles.svg, tones[tone])}
      >
        {segments.length === 0 ? (
          <line
            vectorEffect="non-scaling-stroke"
            x1={0}
            x2={width}
            y1={height / 2}
            y2={height / 2}
            {...stylex.props(styles.empty)}
          />
        ) : null}
        {segments.map((points) => (
          <SparklineSegment
            area={area}
            height={height}
            key={points[0]?.x ?? 0}
            points={points}
          />
        ))}
      </svg>
    </span>
  );
};
