// The public status page's frame (its own top bar and footer, no app
// shell) and its panels, shared by the page and its loading skeleton so
// nothing moves when the data arrives.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  media,
  radius,
  shadows,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";
import { ThemeToggle } from "./theme-toggle.tsx";
import { Skeleton } from "./ui/skeleton.tsx";

const styles = stylex.create({
  bar: {
    alignItems: "center",
    display: "flex",
    flexDirection: "row",
    gap: space.md,
    justifyContent: "space-between",
    minHeight: "3.75rem",
    paddingBlock: space.sm,
  },
  brand: {
    alignItems: "center",
    color: colors.foreground,
    display: "flex",
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
  },
  brandSection: {
    borderLeftColor: colors.border,
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    color: colors.mutedForeground,
    fontWeight: fontWeights.medium,
    marginLeft: space.xs,
    paddingLeft: space.md,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    marginInline: "auto",
    maxWidth: "52rem",
    paddingInline: { default: space.lg, [media.md]: space.xl },
    width: "100%",
  },
  footer: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    letterSpacing: tracking.wide,
    paddingBlock: space.xl,
    textAlign: "center",
    textTransform: "uppercase",
  },
  // Full width, like the app's top bar; its row lines up with the column.
  header: {
    backgroundColor: colors.background,
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    paddingBlock: space.xl,
  },
  // The app shell's mark: a frame with a filled core.
  mark: {
    "::after": {
      backgroundColor: "currentColor",
      borderRadius: "1px",
      content: '""',
      flexGrow: 1,
    },
    borderColor: "currentColor",
    borderRadius: radius.sm,
    borderStyle: "solid",
    borderWidth: "1.5px",
    color: colors.primary,
    display: "inline-flex",
    height: "1rem",
    padding: "3px",
    width: "1rem",
  },
  // The canvas with a faint survey grid, like the other public screens.
  root: {
    backgroundColor: colors.background,
    backgroundImage: `linear-gradient(to right, color-mix(in srgb, ${colors.border} 35%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, ${colors.border} 35%, transparent) 1px, transparent 1px)`,
    backgroundPosition: "center top",
    backgroundSize: "2rem 2rem",
    color: colors.foreground,
    display: "flex",
    flexDirection: "column",
    fontSize: fontSizes.md,
    minHeight: "100dvh",
  },
  spacer: {
    flexGrow: 1,
  },
});

/** A panel on the grid: a title bar over rows. */
export const panelStyles = stylex.create({
  // Mono and muted, on the bar's right: a period or a count.
  aside: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
  },
  bar: {
    alignItems: "center",
    backgroundColor: colors.secondary,
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    color: colors.foreground,
    display: "flex",
    gap: space.md,
    justifyContent: "space-between",
    margin: 0,
    paddingBlock: space.md,
    paddingInline: { default: space.lg, [media.md]: space.xl },
  },
  // A panel on the grid: the card surface with a raised title bar.
  panel: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.sm,
    color: colors.cardForeground,
    overflow: "hidden",
  },
  title: {
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.medium,
    margin: 0,
  },
});

/** The canvas, the top bar (brand, theme) and the footer around `children`. */
export const StatusFrame = ({ children }: { readonly children: ReactNode }) => (
  <div {...stylex.props(styles.root)}>
    <header {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.column, styles.bar)}>
        <span {...stylex.props(styles.brand)}>
          <span aria-hidden {...stylex.props(styles.mark)} />
          Kanshi
          <span {...stylex.props(styles.brandSection)}>Status</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
    <main {...stylex.props(styles.column, styles.main)}>{children}</main>
    <div {...stylex.props(styles.spacer)} />
    <footer {...stylex.props(styles.column, styles.footer)}>
      Kanshi // uptime monitor
    </footer>
  </div>
);

const skeleton = stylex.create({
  axis: { height: "0.75rem" },
  bars: { height: "1.75rem" },
  eyebrow: { height: "0.6875rem", width: "6rem" },
  // The status banner's card, its lines centered.
  hero: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.sm,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    paddingBlock: { default: space.xxl, [media.md]: space.xxxl },
    paddingInline: space.lg,
  },
  meta: { height: "1rem", maxWidth: "100%", width: "16rem" },
  name: { height: "1rem", width: "8rem" },
  pill: { height: "1.75rem", width: "7.5rem" },
  row: {
    borderTopColor: colors.border,
    borderTopStyle: { ":first-child": "none", default: "solid" },
    borderTopWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    paddingBlock: space.lg,
    paddingInline: { default: space.lg, [media.md]: space.xl },
  },
  summary: { height: "1.125rem", maxWidth: "100%", width: "11rem" },
  // Summary and meta: the banner's two lines, as close as its own.
  text: {
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: "100%",
  },
  title: {
    height: { default: "1.95rem", [media.md]: "2.4rem" },
    maxWidth: "100%",
    width: "18rem",
  },
  titleBar: { height: "1rem", width: "5rem" },
});

/** The page while it loads: the banner and a monitors panel, in outline. */
export const StatusSkeleton = () => (
  <StatusFrame>
    <output aria-busy aria-label="Loading status">
      <div {...stylex.props(skeleton.hero)}>
        <Skeleton style={skeleton.eyebrow} />
        <Skeleton style={skeleton.title} />
        <Skeleton style={skeleton.pill} />
        <div {...stylex.props(skeleton.text)}>
          <Skeleton style={skeleton.summary} />
          <Skeleton style={skeleton.meta} />
        </div>
      </div>
    </output>
    <div aria-hidden {...stylex.props(panelStyles.panel)}>
      <div {...stylex.props(panelStyles.bar)}>
        <Skeleton style={skeleton.titleBar} />
      </div>
      {[0, 1].map((index) => (
        <div key={index} {...stylex.props(skeleton.row)}>
          <Skeleton style={skeleton.name} />
          <Skeleton style={skeleton.bars} />
          <Skeleton style={skeleton.axis} />
        </div>
      ))}
    </div>
  </StatusFrame>
);
