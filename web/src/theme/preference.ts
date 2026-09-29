// The user's theme choice (system, light or dark), stored in localStorage
// and resolved against `prefers-color-scheme`. `web/public/theme-init.js`
// repeats the key and the rule to set `data-theme` before first paint;
// keep them in sync.
import * as stylex from "@stylexjs/stylex";

import type { ResolvedTheme } from "./themes.ts";
import { themes } from "./themes.ts";
import { colors, fonts, lineHeights } from "./tokens.stylex.ts";

export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];

export const themeStorageKey = "kanshi-theme";
export const darkSchemeQuery = "(prefers-color-scheme: dark)";

/** Anything unknown (or nothing stored) means "follow the system". */
export const parsePreference = (raw: string | null): ThemePreference =>
  themePreferences.find((preference) => preference === raw) ?? "system";

export const resolveTheme = (
  preference: ThemePreference,
  systemDark: boolean
): ResolvedTheme => {
  if (preference === "system") {
    return systemDark ? "dark" : "light";
  }
  return preference;
};

/** Storage can throw (disabled, sandboxed); fall back to the system. */
export const readStoredPreference = (): ThemePreference => {
  try {
    return parsePreference(localStorage.getItem(themeStorageKey));
  } catch {
    return "system";
  }
};

export const storePreference = (preference: ThemePreference) => {
  try {
    if (preference === "system") {
      localStorage.removeItem(themeStorageKey);
    } else {
      localStorage.setItem(themeStorageKey, preference);
    }
  } catch {
    // Not persisted; the choice still applies to this page.
  }
};

const rootStyles = stylex.create({
  root: {
    WebkitFontSmoothing: "antialiased",
    color: colors.foreground,
    fontFamily: fonts.sans,
    // No font-size here: on <html> it would rescale every rem.
    lineHeight: lineHeights.normal,
  },
});

/**
 * Puts the theme on `<html>`: StyleX's variable overrides (so portals
 * rendered into `<body>` get them), the base text styles, and `data-theme`
 * (read by the pre-paint background rule in `index.css`).
 */
export const applyTheme = (root: HTMLElement, theme: ResolvedTheme) => {
  root.className = stylex.props(rootStyles.root, themes[theme]).className ?? "";
  root.dataset.theme = theme;
};
