// Rows of floating lists (DropdownMenu, Select): the highlighted row is
// inverted to ink with a filled square marker, like the game's menus.
import * as stylex from "@stylexjs/stylex";

import {
  colors,
  fontSizes,
  layers,
  radius,
  space,
} from "../../theme/tokens.stylex.ts";

export const menuStyles = stylex.create({
  destructive: {
    backgroundColor: {
      ":is([data-highlighted])": colors.destructive,
      default: "transparent",
    },
    color: {
      ":is([data-highlighted])": colors.destructiveForeground,
      default: colors.dangerForeground,
    },
  },
  item: {
    "::before": {
      backgroundColor: "currentColor",
      content: '""',
      flexShrink: 0,
      height: "0.375rem",
      opacity: { ":is([data-highlighted])": 1, default: 0 },
      width: "0.375rem",
    },
    alignItems: "center",
    backgroundColor: {
      ":is([data-highlighted])": colors.primary,
      default: "transparent",
    },
    borderRadius: radius.sm,
    color: {
      ":is([data-highlighted])": colors.primaryForeground,
      default: colors.popoverForeground,
    },
    cursor: "default",
    display: "flex",
    fontSize: fontSizes.sm,
    gap: space.sm,
    minHeight: "2rem",
    opacity: { ":is([data-disabled])": 0.5, default: 1 },
    outline: "none",
    paddingInline: space.sm,
    userSelect: "none",
  },
  positioner: {
    outline: "none",
    zIndex: layers.popover,
  },
  separator: {
    backgroundColor: colors.border,
    height: "1px",
    marginBlock: space.xs,
    marginInline: `calc(-1 * ${space.xs})`,
  },
});
