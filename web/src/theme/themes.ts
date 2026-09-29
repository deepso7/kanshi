// Themes over the token groups in `tokens.stylex.ts`. A theme is applied
// with `stylex.props(theme)` to an element and covers its subtree; the
// theme provider applies the active one to `<html>` so portals (dialogs,
// menus, toasts) get it too.
import * as stylex from "@stylexjs/stylex";

import { colors, shadows } from "./tokens.stylex.ts";

/** The charcoal variant of the reference theme (`variants.dark`). */
const darkColors = stylex.createTheme(colors, {
  accent: "#45433a",
  accentForeground: "#d1cdb7",
  background: "#2f2d26",
  border: "#4f4d45",
  // surface: a step above the canvas
  card: "#36342c",
  cardForeground: "#d1cdb7",
  chart1: "#d1cdb7",
  chart2: "#95ab6e",
  chart3: "#c96b57",
  chart4: "#c2b169",
  chart5: "#9a988a",
  danger: "#c96b57",
  dangerForeground: "#d98a77",
  dangerSurface: "#45302a",
  destructive: "#d98a77",
  destructiveForeground: "#2f2d26",
  foreground: "#d1cdb7",
  input: "#5a584e",
  muted: "#3d3b33",
  mutedForeground: "#a8a593",
  overlay: "rgb(0 0 0 / 0.5)",
  placeholder: "#9a988a",
  popover: "#403e35",
  popoverForeground: "#d1cdb7",
  primary: "#d1cdb7",
  primaryForeground: "#2f2d26",
  primaryHover: "#c4bfa6",
  ring: "#d1cdb7",
  secondary: "#3d3b33",
  secondaryForeground: "#d1cdb7",
  secondaryHover: "#45433a",
  sidebar: "#282620",
  sidebarAccent: "#33312a",
  sidebarAccentForeground: "#d1cdb7",
  sidebarBorder: "#49473f",
  sidebarForeground: "#d1cdb7",
  sidebarMutedForeground: "#9d9986",
  sidebarPrimary: "#d1cdb7",
  sidebarPrimaryForeground: "#2f2d26",
  sidebarRing: "#d1cdb7",
  success: "#95ab6e",
  successForeground: "#b4c48c",
  successSurface: "#363b29",
  unknown: "#9a988a",
  unknownForeground: "#a8a593",
  unknownSurface: "#3d3b33",
  warning: "#c2b169",
  warningForeground: "#d3c47e",
  warningSurface: "#403a24",
});

const darkShadows = stylex.createTheme(shadows, {
  lg: "0 10px 30px rgb(0 0 0 / 0.5), 0 1px 3px rgb(0 0 0 / 0.4)",
  md: "0 2px 8px rgb(0 0 0 / 0.35)",
  sm: "0 1px 0 rgb(0 0 0 / 0.2)",
});

/** Empty themes reset a subtree to the defaults (the light theme). */
const lightColors = stylex.createTheme(colors, {});
const lightShadows = stylex.createTheme(shadows, {});

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
