// Design tokens (StyleX variables), named after shadcn's semantic tokens.
//
// StyleX rules for this file: every `defineVars` / `defineConsts` is a
// direct named export, nothing else is exported, and values are literals
// (the compiler evaluates them statically). Import the groups anywhere and
// use them as values in `stylex.create`.
//
// The defaults are the light theme ("NieR: Automata", parchment and ink,
// see `nier-automata.json` next to this file). The dark variant is a
// `createTheme` in `themes.ts`, applied to `<html>` by the theme provider.
import * as stylex from "@stylexjs/stylex";

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

/**
 * Colors, shadcn's semantic names. The comment above a value names the
 * reference theme's key it comes from.
 *
 * Status colors come in threes: the solid color (dots, bars), a
 * `...Surface` (badges, banners) and a `...Foreground` (text on that
 * surface). `success` (up) is not in the reference: a muted olive (hue
 * ~85°, the parchment's own saturation) that reads as "fine" next to the
 * mustard warning and the rust error without introducing a bright green.
 * `up`/`down`/`paused` map to `success`/`danger`/`unknown`.
 *
 * Charts: ink, then the status hues, then a neutral.
 */
export const colors = stylex.defineVars({
  // toolbarControlHover
  accent: "#b8b49c",
  accentForeground: "#211f1b",
  // canvas
  background: "#ccc8b1",
  // border
  border: "#a29e89",
  // surfaceRaised
  card: "#d1cdb7",
  cardForeground: "#211f1b",
  chart1: "#4d4b3f",
  chart2: "#56683d",
  chart3: "#95402f",
  chart4: "#8c7a2e",
  chart5: "#7a7560",
  // error (down)
  danger: "#a94a38",
  // errorForeground
  dangerForeground: "#7d3427",
  // errorSurface
  dangerSurface: "#cfb7a2",
  // Destructive actions: `error`, darkened for 4.8:1 with its text.
  destructive: "#95402f",
  destructiveForeground: "#dcd8c2",
  // text
  foreground: "#211f1b",
  // input
  input: "#928e7a",
  // muted
  muted: "#c1bda5",
  // mutedForeground
  mutedForeground: "#4d4b3f",
  overlay: "rgb(33 31 27 / 0.35)",
  // placeholder
  placeholder: "#4d4b40",
  // surfaceOverlay
  popover: "#d7d3bf",
  popoverForeground: "#211f1b",
  // accent
  primary: "#211f1b",
  // accentForeground
  primaryForeground: "#dcd8c2",
  // messageActionHover
  primaryHover: "#5a5647",
  // focus
  ring: "#211f1b",
  // secondary
  secondary: "#c1bda5",
  secondaryForeground: "#211f1b",
  // toolbarControlHover
  secondaryHover: "#b8b49c",
  // sidebar
  sidebar: "#bfbba4",
  // sidebarRowHover
  sidebarAccent: "#b8b49d",
  sidebarAccentForeground: "#211f1b",
  // sidebarBorder
  sidebarBorder: "#95917d",
  // sidebarForeground
  sidebarForeground: "#211f1b",
  // sidebarMutedForeground
  sidebarMutedForeground: "#4d4b3f",
  sidebarPrimary: "#211f1b",
  sidebarPrimaryForeground: "#dcd8c2",
  sidebarRing: "#211f1b",
  // derived olive (up)
  success: "#56683d",
  successForeground: "#3d4a28",
  successSurface: "#bcc3a0",
  // unknown and paused
  unknown: "#6f6b59",
  // mutedForeground
  unknownForeground: "#4d4b3f",
  // muted
  unknownSurface: "#c1bda5",
  // warning, deepened for bars on parchment
  warning: "#8c7a2e",
  // warningForeground
  warningForeground: "#5c5022",
  // warningSurface
  warningSurface: "#ccc49e",
});

export const fonts = stylex.defineVars({
  /** Data: numbers, URLs, timestamps, labels. */
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  /** Running text. */
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
});

export const fontSizes = stylex.defineVars({
  lg: "1rem",
  // 14px: body
  md: "0.875rem",
  // 13px: table cells, controls
  sm: "0.8125rem",
  xl: "1.25rem",
  // 11px: labels, captions
  xs: "0.6875rem",
  xxl: "1.625rem",
  xxxl: "2rem",
});

export const fontWeights = stylex.defineVars({
  medium: "500",
  normal: "400",
  semibold: "600",
});

export const lineHeights = stylex.defineVars({
  normal: "1.5",
  tight: "1.2",
});

export const tracking = stylex.defineVars({
  normal: "0",
  /** Uppercase labels and headings (the YoRHa look). */
  wide: "0.08em",
  wider: "0.14em",
});

export const space = stylex.defineVars({
  lg: "1rem",
  md: "0.75rem",
  sm: "0.5rem",
  xl: "1.5rem",
  xs: "0.25rem",
  xxl: "2rem",
  xxs: "0.125rem",
  xxxl: "3rem",
});

/** Square-ish, like the game's panels. */
export const radius = stylex.defineVars({
  full: "9999px",
  lg: "4px",
  md: "2px",
  none: "0",
  sm: "1px",
});

export const shadows = stylex.defineVars({
  lg: "0 8px 24px rgb(33 31 27 / 0.18), 0 1px 3px rgb(33 31 27 / 0.12)",
  md: "0 2px 6px rgb(33 31 27 / 0.12)",
  sm: "0 1px 0 rgb(33 31 27 / 0.06)",
});

/** Durations drop to zero when the user asks for reduced motion. */
export const motion = stylex.defineVars({
  ease: "cubic-bezier(0.2, 0, 0, 1)",
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
  fast: { default: "100ms", [REDUCED_MOTION]: "0ms" },
  normal: { default: "160ms", [REDUCED_MOTION]: "0ms" },
  slow: { default: "260ms", [REDUCED_MOTION]: "0ms" },
});

/** Stacking order of overlays; constants, not variables. */
export const layers = stylex.defineConsts({
  overlay: "50",
  popover: "60",
  sticky: "10",
  toast: "70",
});

/** Media queries for `stylex.create` keys. */
export const media = stylex.defineConsts({
  lg: "@media (min-width: 1024px)",
  md: "@media (min-width: 768px)",
  reducedMotion: "@media (prefers-reduced-motion: reduce)",
});
