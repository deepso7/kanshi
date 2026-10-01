// Themes over the token groups in `tokens.stylex.ts`. A theme is applied
// with `stylex.props(theme)` to an element and covers its subtree; the
// theme provider applies the active one to `<html>` so portals (dialogs,
// menus, toasts) get it too.
import * as stylex from "@stylexjs/stylex";

import { colors, shadows } from "./tokens.stylex.ts";

/**
 * A light counterpart to the reference (it has none): the same neutral
 * grays inverted, the orange accent kept for fills, and the status hues
 * deepened to read on white.
 */
const lightColors = stylex.createTheme(colors, {
  accent: "oklch(0.946 0 0)",
  accentForeground: "oklch(0.173 0 0)",
  background: "oklch(0.985 0 0)",
  border: "oklch(0.919 0 0)",
  card: "oklch(1 0 0)",
  cardForeground: "oklch(0.173 0 0)",
  chart1: "oklch(0.6 0.148 52.8)",
  chart2: "oklch(0.564 0.111 168.7)",
  chart3: "oklch(0.575 0.186 25.2)",
  chart4: "oklch(0.528 0 0)",
  chart5: "oklch(0.757 0 0)",
  danger: "oklch(0.575 0.186 25.2)",
  dangerForeground: "oklch(0.5 0.171 25.9)",
  dangerSurface: "oklch(0.957 0.018 17.5)",
  destructive: "oklch(0.544 0.186 26)",
  destructiveForeground: "oklch(1 0 0)",
  foreground: "oklch(0.173 0 0)",
  input: "oklch(0.65 0 0)",
  muted: "oklch(0.964 0 0)",
  mutedForeground: "oklch(0.475 0 0)",
  overlay: "oklch(0.173 0 0 / 0.35)",
  placeholder: "oklch(0.556 0 0)",
  popover: "oklch(1 0 0)",
  popoverForeground: "oklch(0.173 0 0)",
  primary: "oklch(0.869 0.088 60.7)",
  primaryForeground: "oklch(0 0 0)",
  primaryHover: "oklch(0.836 0.114 61.4)",
  // The accent is 1.4:1 on white: a burnt orange for focus.
  ring: "oklch(0.6 0.148 52.8)",
  secondary: "oklch(0.964 0 0)",
  secondaryForeground: "oklch(0.173 0 0)",
  secondaryHover: "oklch(0.931 0 0)",
  success: "oklch(0.564 0.111 168.7)",
  successForeground: "oklch(0.47 0.091 169)",
  successSurface: "oklch(0.957 0.022 176)",
  toolbar: "oklch(0.985 0 0)",
  toolbarAccent: "oklch(0.946 0 0)",
  toolbarActive: "oklch(0.931 0 0)",
  toolbarBorder: "oklch(0.919 0 0)",
  toolbarForeground: "oklch(0.173 0 0)",
  toolbarMutedForeground: "oklch(0.475 0 0)",
  unknown: "oklch(0.65 0 0)",
  unknownForeground: "oklch(0.475 0 0)",
  unknownSurface: "oklch(0.955 0 0)",
  warning: "oklch(0.629 0.138 62.7)",
  warningForeground: "oklch(0.487 0.109 62.1)",
  warningSurface: "oklch(0.964 0.023 71.8)",
});

const lightShadows = stylex.createTheme(shadows, {
  lg: "0 8px 24px oklch(0.173 0 0 / 0.12), 0 1px 3px oklch(0.173 0 0 / 0.08)",
  md: "0 2px 6px oklch(0.173 0 0 / 0.08)",
  sm: "0 1px 0 oklch(0.173 0 0 / 0.04)",
});

/** Empty themes reset a subtree to the defaults (the dark theme). */
const darkColors = stylex.createTheme(colors, {});
const darkShadows = stylex.createTheme(shadows, {});

const schemes = stylex.create({
  dark: { colorScheme: "dark" },
  light: { colorScheme: "light" },
});

/**
 * Everything a subtree needs to render in one theme: the variable
 * overrides plus `color-scheme` (native scrollbars and form controls).
 * Pass one to `stylex.props`.
 */
export const themes = {
  dark: [darkColors, darkShadows, schemes.dark],
  light: [lightColors, lightShadows, schemes.light],
} as const;

export type ResolvedTheme = keyof typeof themes;
