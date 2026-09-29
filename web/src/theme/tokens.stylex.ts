// Design tokens (StyleX variables). `defineVars` must live in a
// `.stylex.ts` file and be a named export; import them anywhere and use
// them as values in `stylex.create`. Dark mode follows the system.
import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

export const colors = stylex.defineVars({
  accent: { default: "#3b5bdb", [DARK]: "#7c93f5" },
  accentText: { default: "#fff", [DARK]: "#111214" },
  bad: { default: "#e03131", [DARK]: "#ff6b6b" },
  badBg: { default: "#fdecec", [DARK]: "#3a1a1a" },
  bg: { default: "#f7f7f8", [DARK]: "#111214" },
  border: { default: "#e3e4e8", [DARK]: "#2c2e33" },
  muted: { default: "#6b6f76", [DARK]: "#9a9ea6" },
  none: { default: "#d9dbe0", [DARK]: "#2c2e33" },
  ok: { default: "#2f9e44", [DARK]: "#40c057" },
  okBg: { default: "#e6f6ea", [DARK]: "#16301d" },
  panel: { default: "#fff", [DARK]: "#1a1b1e" },
  partial: { default: "#a6abb5", [DARK]: "#5c616b" },
  text: { default: "#1b1c1f", [DARK]: "#e6e7ea" },
  warn: { default: "#e8a317", [DARK]: "#f0b429" },
  warnBg: { default: "#fff6e0", [DARK]: "#3a2f12" },
});

export const fonts = stylex.defineVars({
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
});

export const space = stylex.defineVars({
  lg: "1rem",
  md: "0.75rem",
  sm: "0.5rem",
  xl: "1.5rem",
  xs: "0.25rem",
  xxl: "2rem",
});

export const radius = stylex.defineVars({
  md: "10px",
  pill: "999px",
  sm: "8px",
});
