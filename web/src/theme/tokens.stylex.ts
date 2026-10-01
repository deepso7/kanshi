// Design tokens (StyleX variables), named after shadcn's semantic tokens.
//
// StyleX rules for this file: every `defineVars` / `defineConsts` is a
// direct named export, nothing else is exported, and values are literals
// (the compiler evaluates them statically). Import the groups anywhere and
// use them as values in `stylex.create`.
//
// The defaults are the dark theme ("Vesper": near-black, white text,
// orange accent, see `vesper.json` next to this file). The light variant is
// a `createTheme` in `themes.ts`, applied to `<html>` by the theme provider.
import * as stylex from "@stylexjs/stylex";

const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

/**
 * Colors, shadcn's semantic names, in oklch. The comment above a value
 * names the reference theme's key it comes from (the reference is hex).
 *
 * Status colors come in threes: the solid color (dots, bars), a
 * `...Surface` (badges, banners) and a `...Foreground` (text on that
 * surface). `success` (up) is not in the reference: Vesper's peppermint
 * (`#99ffe4`, its editor theme's string color), with a surface made like
 * the reference's `errorSurface`. `up`/`down`/`paused` map to
 * `success`/`danger`/`unknown`.
 *
 * Charts: the accent, then the status hues, then a neutral.
 */
export const colors = stylex.defineVars({
  // toolbarControlHover
  accent: "oklch(0.277 0 0)",
  accentForeground: "oklch(1 0 0)",
  // canvas
  background: "oklch(0.173 0 0)",
  // sidebarRowActive: the reference's `border` (#1c1c1c) vanishes on cards.
  border: "oklch(0.256 0 0)",
  // surfaceRaised
  card: "oklch(0.2 0 0)",
  cardForeground: "oklch(1 0 0)",
  chart1: "oklch(0.869 0.088 60.7)",
  chart2: "oklch(0.93 0.103 175.1)",
  chart3: "oklch(0.744 0.155 21.5)",
  chart4: "oklch(0.706 0 0)",
  chart5: "oklch(0.431 0 0)",
  // error (down)
  danger: "oklch(0.744 0.155 21.5)",
  // errorForeground
  dangerForeground: "oklch(0.744 0.155 21.5)",
  // errorSurface
  dangerSurface: "oklch(0.225 0.035 20.1)",
  destructive: "oklch(0.744 0.155 21.5)",
  destructiveForeground: "oklch(0 0 0)",
  // text
  foreground: "oklch(1 0 0)",
  // Control borders: iconMuted, lifted to 3:1 on the canvas.
  input: "oklch(0.528 0 0)",
  // muted
  muted: "oklch(0.2 0 0)",
  // mutedForeground
  mutedForeground: "oklch(0.706 0 0)",
  overlay: "oklch(0 0 0 / 0.6)",
  // The reference's `placeholder` (#505050) is 2.4:1; Vesper's comment gray.
  placeholder: "oklch(0.637 0 0)",
  // surfaceOverlay
  popover: "oklch(0.226 0 0)",
  popoverForeground: "oklch(1 0 0)",
  // accent
  primary: "oklch(0.869 0.088 60.7)",
  // accentForeground
  primaryForeground: "oklch(0 0 0)",
  // messageActionHover
  primaryHover: "oklch(0.887 0.075 60.7)",
  // focus
  ring: "oklch(0.869 0.088 60.7)",
  // toolbarControl
  secondary: "oklch(0.226 0 0)",
  secondaryForeground: "oklch(1 0 0)",
  // toolbarControlHover
  secondaryHover: "oklch(0.277 0 0)",
  // derived peppermint (up)
  success: "oklch(0.93 0.103 175.1)",
  successForeground: "oklch(0.93 0.103 175.1)",
  successSurface: "oklch(0.265 0.030 173.7)",
  // toolbar
  toolbar: "oklch(0.173 0 0)",
  // toolbarControlHover
  toolbarAccent: "oklch(0.277 0 0)",
  // sidebarRowActive
  toolbarActive: "oklch(0.256 0 0)",
  // toolbarBorder, as `border`
  toolbarBorder: "oklch(0.256 0 0)",
  // toolbarForeground
  toolbarForeground: "oklch(1 0 0)",
  // sidebarMutedForeground
  toolbarMutedForeground: "oklch(0.706 0 0)",
  // unknown and paused
  unknown: "oklch(0.58 0 0)",
  // mutedForeground
  unknownForeground: "oklch(0.706 0 0)",
  // surfaceOverlay
  unknownSurface: "oklch(0.226 0 0)",
  // warning
  warning: "oklch(0.869 0.088 60.7)",
  // warningForeground
  warningForeground: "oklch(0.869 0.088 60.7)",
  // warningSurface
  warningSurface: "oklch(0.252 0.025 69)",
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
  /** Uppercase labels and headings. */
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

/** Small radii: crisp panels, softened corners. */
export const radius = stylex.defineVars({
  full: "9999px",
  lg: "8px",
  md: "6px",
  none: "0",
  sm: "4px",
});

export const shadows = stylex.defineVars({
  lg: "0 10px 30px oklch(0 0 0 / 0.5), 0 1px 3px oklch(0 0 0 / 0.4)",
  md: "0 2px 8px oklch(0 0 0 / 0.35)",
  sm: "0 1px 0 oklch(0 0 0 / 0.2)",
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
