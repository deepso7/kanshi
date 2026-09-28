import type { RecentBucket } from "../domain/history.ts";
import { formatPercent } from "./format.ts";
import type { Html } from "./html.ts";
import { html } from "./html.ts";

/** The fields of a day that the uptime bars need. */
export interface BarDay {
  readonly day: string;
  readonly partial: boolean;
  readonly uptimePercent: number | null;
}

export type BarLevel = "ok" | "warn" | "bad" | "partial" | "none";

/**
 * A day's colour: grey when partial (too few samples to trust), empty
 * without samples, otherwise by uptime.
 */
export const barLevel = (day: BarDay | null): BarLevel => {
  if (day === null || (day.uptimePercent === null && !day.partial)) {
    return "none";
  }
  if (day.partial || day.uptimePercent === null) {
    return "partial";
  }
  if (day.uptimePercent >= 99.5) {
    return "ok";
  }
  return day.uptimePercent >= 95 ? "warn" : "bad";
};

const barTitle = (day: BarDay | null): string => {
  if (day === null) {
    return "No data";
  }
  const percent =
    day.uptimePercent === null
      ? "no samples"
      : formatPercent(day.uptimePercent);
  return `${day.day}: ${percent}${day.partial ? " (partial)" : ""}`;
};

const barWidth = 3;
const barGap = 1;
const barHeight = 28;

/**
 * One bar per day, oldest left, today right; missing leading days (a young
 * monitor) are padded as empty bars so every chart lines up.
 */
export const uptimeBars = (days: readonly BarDay[], count = 90): Html => {
  const recent = days.slice(-count);
  const padded: readonly (BarDay | null)[] = [
    ...Array.from({ length: count - recent.length }, () => null),
    ...recent,
  ];
  const width = count * (barWidth + barGap) - barGap;
  const bars = padded.map(
    (day, index) =>
      html`<rect
        x="${index * (barWidth + barGap)}"
        y="0"
        width="${barWidth}"
        height="${barHeight}"
        rx="1"
        class="bar-${barLevel(day)}"
        ><title>${barTitle(day)}</title></rect
      >`
  );
  return html`<svg
    class="bars"
    viewBox="0 0 ${width} ${barHeight}"
    preserveAspectRatio="none"
    role="img"
    aria-label="Uptime per day, last ${count} days"
  >
    ${bars}
  </svg>`;
};

const sparkWidth = 120;
const sparkHeight = 28;
const sparkPad = 2;

/**
 * SVG path of the latency line; gaps (no successful check) break it, and a
 * bucket with no known neighbour is drawn as a dot.
 */
export const sparklinePath = (
  buckets: readonly RecentBucket[],
  width = sparkWidth,
  height = sparkHeight
): string => {
  const values = buckets.map((bucket) => bucket.latencyMs);
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) {
    return "";
  }
  const max = Math.max(...known, 1);
  const step = buckets.length > 1 ? width / (buckets.length - 1) : 0;
  const y = (value: number) =>
    sparkPad + (height - 2 * sparkPad) * (1 - value / max);
  let path = "";
  for (const [index, value] of values.entries()) {
    if (value !== null) {
      const drawing = index > 0 && values[index - 1] !== null;
      const isolated = !drawing && (values[index + 1] ?? null) === null;
      const command = drawing ? "L" : "M";
      path += `${command}${(index * step).toFixed(1)} ${y(value).toFixed(1)}`;
      // A lone point is a zero-length segment: the round linecap draws it
      // as a dot, where a bare `M` would draw nothing.
      if (isolated) {
        path += "h0";
      }
    }
  }
  return path;
};

/**
 * Mean latency per bucket as a line, with red ticks at the bottom for
 * buckets with counted failures.
 */
export const sparkline = (
  buckets: readonly RecentBucket[],
  options: {
    readonly width?: number;
    readonly height?: number;
    /** Stretch to the container's width (CSS), keeping the stroke width. */
    readonly fluid?: boolean;
  } = {}
): Html => {
  const width = options.width ?? sparkWidth;
  const height = options.height ?? sparkHeight;
  const path = sparklinePath(buckets, width, height);
  const known = buckets
    .map((bucket) => bucket.latencyMs)
    .filter((value): value is number => value !== null);
  const step = buckets.length > 1 ? width / (buckets.length - 1) : 0;
  const failures = buckets.flatMap((bucket, index) =>
    bucket.failures > 0
      ? [
          html`<rect
            class="spark-fail"
            x="${Math.max(0, index * step - 1).toFixed(1)}"
            y="${height - 3}"
            width="2"
            height="3"
          />`,
        ]
      : []
  );
  const label =
    known.length === 0
      ? "No latency data"
      : `Latency ${Math.min(...known)}–${Math.max(...known)} ms`;
  const size =
    options.fluid === true
      ? html`preserveAspectRatio="none" style="height:${height}px"`
      : html`width="${width}" height="${height}"`;
  return html`<svg
    class="spark${options.fluid === true ? " fluid" : ""}"
    ${size}
    viewBox="0 0 ${width} ${height}"
    role="img"
    aria-label="${label}"
  >
    <title>${label}</title>
    ${
      path === ""
        ? html`<line
            class="spark-empty"
            x1="0"
            y1="${height / 2}"
            x2="${width}"
            y2="${height / 2}"
          />`
        : html`<path class="spark-line" d="${path}" />`
    }
    ${failures}
  </svg>`;
};
