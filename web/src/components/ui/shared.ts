// Style fragments shared by the components: focus ring, the uppercase
// label look, and the panel surface used by popovers, menus and dialogs.
import * as stylex from "@stylexjs/stylex";

import {
  colors,
  fontSizes,
  fontWeights,
  motion,
  radius,
  shadows,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";

export const shared = stylex.create({
  /** A thin ink outline, offset like the game's selection frame. */
  focusRing: {
    outlineColor: colors.ring,
    outlineOffset: "2px",
    outlineStyle: { ":focus-visible": "solid", default: "none" },
    outlineWidth: "1px",
  },
  /** Uppercase, tracked, small: labels, table heads, eyebrows. */
  label: {
    color: colors.mutedForeground,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    letterSpacing: tracking.wide,
    lineHeight: "1rem",
    textTransform: "uppercase",
  },
  /** Floating panels: popovers, menus, select lists. */
  popup: {
    backgroundColor: colors.popover,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.lg,
    color: colors.popoverForeground,
    opacity: {
      ":is([data-ending-style])": 0,
      ":is([data-starting-style])": 0,
      default: 1,
    },
    outline: "none",
    padding: space.xs,
    transform: {
      ":is([data-ending-style])": "translateY(-2px)",
      ":is([data-starting-style])": "translateY(-2px)",
      default: "none",
    },
    transformOrigin: "var(--transform-origin)",
    transitionDuration: motion.fast,
    transitionProperty: "opacity, transform",
    transitionTimingFunction: motion.easeOut,
  },
  /** Screen-reader-only text. */
  srOnly: {
    borderWidth: 0,
    clip: "rect(0 0 0 0)",
    height: "1px",
    margin: "-1px",
    overflow: "hidden",
    padding: 0,
    position: "absolute",
    whiteSpace: "nowrap",
    width: "1px",
  },
});
