import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  media,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";
import { ThemeToggle } from "./theme-toggle.tsx";

const styles = stylex.create({
  bar: {
    alignItems: "center",
    display: "flex",
    gap: space.md,
    justifyContent: "space-between",
    paddingBlock: space.lg,
    paddingInline: { default: space.lg, [media.md]: space.xxl },
  },
  brand: {
    alignItems: "center",
    color: colors.foreground,
    display: "flex",
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    letterSpacing: tracking.wider,
    textTransform: "uppercase",
  },
  center: {
    alignItems: "center",
    display: "flex",
    justifyContent: "center",
    paddingBlock: space.xl,
    paddingInline: space.lg,
  },
  footer: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    letterSpacing: tracking.wide,
    textAlign: "center",
    textTransform: "uppercase",
  },
  // The brand mark of the app shell: a frame with a filled core.
  mark: {
    "::after": {
      backgroundColor: "currentColor",
      content: '""',
      flexGrow: 1,
    },
    borderColor: "currentColor",
    borderStyle: "solid",
    borderWidth: "1px",
    display: "inline-flex",
    height: "1rem",
    padding: "3px",
    width: "1rem",
  },
  // Parchment with a faint survey grid, like the game's menus.
  root: {
    backgroundColor: colors.background,
    backgroundImage: `linear-gradient(to right, color-mix(in srgb, ${colors.border} 35%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, ${colors.border} 35%, transparent) 1px, transparent 1px)`,
    backgroundPosition: "center center",
    backgroundSize: "2rem 2rem",
    color: colors.foreground,
    display: "grid",
    fontSize: fontSizes.md,
    gridTemplateRows: "auto 1fr auto",
    minHeight: "100dvh",
  },
});

export interface CenteredScreenProps {
  /** The centred content: a card, a panel. */
  readonly children: ReactNode;
  /** A mono line at the bottom. */
  readonly footer?: ReactNode;
}

/**
 * A full screen outside the app shell (login, not found, a failed
 * session check): the brand and the theme toggle on top, the content in
 * the middle of a gridded canvas.
 */
export const CenteredScreen = ({ children, footer }: CenteredScreenProps) => (
  <div {...stylex.props(styles.root)}>
    <header {...stylex.props(styles.bar)}>
      <span {...stylex.props(styles.brand)}>
        <span aria-hidden {...stylex.props(styles.mark)} />
        Kanshi
      </span>
      <ThemeToggle />
    </header>
    <main {...stylex.props(styles.center)}>{children}</main>
    <footer {...stylex.props(styles.bar, styles.footer)}>
      {footer ?? <span>Kanshi // uptime monitor</span>}
    </footer>
  </div>
);
