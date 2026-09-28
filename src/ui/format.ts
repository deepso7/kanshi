import type { Html } from "./html.ts";
import { html } from "./html.ts";

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

/** A compact duration: `45s`, `4m 12s`, `2h 5m`, `3d 4h`. */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / second));
  if (total < 60) {
    return `${total}s`;
  }
  const units: readonly (readonly [number, string])[] = [
    [day / second, "d"],
    [hour / second, "h"],
    [minute / second, "m"],
    [1, "s"],
  ];
  const parts: string[] = [];
  let rest = total;
  for (const [size, label] of units) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 || parts.length > 0) {
      parts.push(`${count}${label}`);
    }
  }
  return parts
    .slice(0, 2)
    .join(" ")
    .replace(/ 0[a-z]$/u, "");
};

/** `just now`, `12s ago`, `5m ago`, `3h ago`, `2d ago`. */
export const formatAgo = (at: number, now: number): string => {
  const elapsed = now - at;
  if (elapsed < 5 * second) {
    return "just now";
  }
  const units: readonly (readonly [number, string])[] = [
    [day, "d"],
    [hour, "h"],
    [minute, "m"],
    [second, "s"],
  ];
  const [size, label] =
    units.find(([unit]) => elapsed >= unit) ?? ([second, "s"] as const);
  return `${Math.floor(elapsed / size)}${label} ago`;
};

/** `99.95%`, `100%`, or an em dash without data. */
export const formatPercent = (percent: number | null): string => {
  if (percent === null) {
    return "—";
  }
  if (percent === 100) {
    return "100%";
  }
  return `${(Math.floor(percent * 100) / 100).toFixed(2)}%`;
};

/** `2026-09-28 18:40 UTC`. */
export const formatUtc = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * A timestamp: UTC text, which the page script rewrites to the browser's
 * local time.
 */
export const timeTag = (at: number): Html =>
  html`<time datetime="${new Date(at).toISOString()}" data-local
    >${formatUtc(at)}</time
  >`;

/** A relative time with the absolute time as its tooltip. */
export const agoTag = (at: number | null, now: number): Html =>
  at === null
    ? html`<span class="muted">never</span>`
    : html`<time
        datetime="${new Date(at).toISOString()}"
        title="${formatUtc(at)}"
        >${formatAgo(at, now)}</time
      >`;
