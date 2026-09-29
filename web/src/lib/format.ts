// Display formatting shared by every page. Pure functions over numbers
// (epoch milliseconds, seconds, percentages); `now` is passed in so a
// ticking clock (`useNow`) drives relative times.

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

/** The placeholder for a value we do not have. */
export const missing = "—";

/** A compact duration: `45s`, `4m 12s`, `2h 5m`, `3d 4h` (two units max). */
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

/** A check interval in seconds: `30s`, `1m`, `5m`, `1h`. */
export const formatInterval = (seconds: number): string =>
  formatDuration(seconds * second);

/**
 * Relative to `now`: `just now`, `12s ago`, `5m ago`, `3h ago`, `2d ago`;
 * `null` (never happened) is `never`. A time in the future (clock skew)
 * reads `just now`.
 */
export const formatAgo = (at: number | null, now: number): string => {
  if (at === null) {
    return "never";
  }
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

/**
 * An uptime percentage: `99.95%`, `100%`, or `—` without data. Truncated,
 * never rounded up: 99.999 is `99.99%`, so only a perfect record is 100%.
 */
export const formatPercent = (percent: number | null): string => {
  if (percent === null) {
    return missing;
  }
  if (percent === 100) {
    return "100%";
  }
  return `${(Math.floor(percent * 100) / 100).toFixed(2)}%`;
};

/** Latency: `142 ms`, `1.24 s` from a second up, `—` without a sample. */
export const formatLatency = (ms: number | null): string => {
  if (ms === null) {
    return missing;
  }
  if (ms < second) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / second).toFixed(2)} s`;
};

/** `2026-09-28 18:40 UTC`: unambiguous, for tooltips and logs. */
export const formatUtc = (at: number): string =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Optional overrides for the local-time formatters (tests pin the zone). */
export interface DateFormatOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

/** Local date and time: `Sep 28, 18:40` (with the year when not this one). */
export const formatDateTime = (
  at: number,
  options: DateFormatOptions = {},
  now: number = Date.now()
): string => {
  const sameYear =
    new Date(at).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Intl.DateTimeFormat(options.locale, {
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    timeZone: options.timeZone,
    year: sameYear ? undefined : "numeric",
  }).format(at);
};

/** Local date: `Sep 28, 2026`. */
export const formatDate = (
  at: number,
  options: DateFormatOptions = {}
): string =>
  new Intl.DateTimeFormat(options.locale, {
    day: "numeric",
    month: "short",
    timeZone: options.timeZone,
    year: "numeric",
  }).format(at);

/**
 * A UTC calendar day as the API sends it (`2026-09-28`, e.g. the uptime
 * bars): `Sep 28, 2026`, not shifted into the local zone.
 */
export const formatDay = (
  isoDay: string,
  options: Pick<DateFormatOptions, "locale"> = {}
): string =>
  formatDate(Date.parse(`${isoDay}T00:00:00Z`), {
    locale: options.locale,
    timeZone: "UTC",
  });
