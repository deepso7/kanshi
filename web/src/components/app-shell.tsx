import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  media,
  motion,
  radius,
  space,
} from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";

/** The page column; the bar's row lines up with it. */
const column = stylex.create({
  column: {
    marginInline: "auto",
    maxWidth: "72rem",
    paddingInline: { default: space.lg, [media.md]: space.xxl },
    width: "100%",
  },
});

const styles = stylex.create({
  actions: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    gap: space.sm,
    marginLeft: "auto",
    // Narrow: beside the brand, the nav wraps below.
    order: { default: 1, [media.md]: 2 },
  },
  bar: {
    alignItems: "center",
    columnGap: { default: space.md, [media.md]: space.xl },
    display: "flex",
    flexWrap: { default: "wrap", [media.md]: "nowrap" },
    minHeight: "3.75rem",
    paddingBlock: space.sm,
    rowGap: space.xs,
  },
  brand: {
    alignItems: "center",
    color: colors.toolbarForeground,
    display: "flex",
    flexShrink: 0,
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
  },
  header: {
    backgroundColor: colors.toolbar,
    borderBottomColor: colors.toolbarBorder,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    color: colors.toolbarForeground,
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
  main: {
    flexGrow: 1,
    minWidth: 0,
    paddingBlock: { default: space.xl, [media.md]: space.xxl },
  },
  nav: {
    display: "flex",
    // Narrow: its own full-width row under the brand, scrolling sideways.
    flexBasis: { default: "100%", [media.md]: "auto" },
    gap: space.xxs,
    marginInline: { default: `calc(-1 * ${space.sm})`, [media.md]: 0 },
    minWidth: 0,
    order: { default: 2, [media.md]: 1 },
    overflowX: "auto",
    paddingInline: { default: space.sm, [media.md]: 0 },
    scrollbarWidth: "none",
  },
  navLink: {
    alignItems: "center",
    backgroundColor: {
      ":hover": colors.toolbarAccent,
      ":is([aria-current=page])": colors.toolbarActive,
      default: "transparent",
    },
    borderRadius: radius.md,
    color: {
      ":hover": colors.toolbarForeground,
      ":is([aria-current=page])": colors.toolbarForeground,
      default: colors.toolbarMutedForeground,
    },
    display: "flex",
    flexShrink: 0,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.medium,
    gap: space.xs,
    height: "2rem",
    paddingInline: space.md,
    textDecoration: "none",
    transitionDuration: motion.fast,
    transitionProperty: "background-color, color",
    whiteSpace: "nowrap",
  },
  shell: {
    backgroundColor: colors.background,
    color: colors.foreground,
    display: "flex",
    flexDirection: "column",
    fontSize: fontSizes.md,
    minHeight: "100dvh",
  },
  // Off screen until focused: the first Tab stop, past the top bar.
  skip: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    color: colors.primaryForeground,
    fontSize: fontSizes.sm,
    left: space.sm,
    paddingBlock: space.xs,
    paddingInline: space.sm,
    position: "fixed",
    textDecoration: "none",
    top: space.sm,
    transform: { ":focus": "none", default: "translateY(-200%)" },
    zIndex: 20,
  },
});

const logo = stylex.create({
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
});

export interface AppShellProps {
  /** Start of the top bar. Default: the Kanshi mark and name. */
  readonly brand?: ReactNode;
  /** After the brand: a small tag such as a "Dev" badge. */
  readonly brandBadge?: ReactNode;
  /** `AppShellNavLink`s. */
  readonly nav: ReactNode;
  /** End of the top bar: the theme toggle, a sign-out button. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/**
 * The signed-in layout: a top bar (brand, navigation, actions) over the
 * page. On narrow screens the navigation wraps to a second row.
 */
export const AppShell = ({
  actions,
  brand,
  brandBadge,
  children,
  nav,
  style,
}: AppShellProps) => (
  <div {...stylex.props(styles.shell, style)}>
    <a href="#main" {...stylex.props(styles.skip, shared.focusRing)}>
      Skip to content
    </a>
    <header {...stylex.props(styles.header)}>
      <div {...stylex.props(column.column, styles.bar)}>
        <div {...stylex.props(styles.brand)}>
          {brand ?? (
            <>
              <span aria-hidden {...stylex.props(logo.mark)} />
              Kanshi
            </>
          )}
          {brandBadge}
        </div>
        <nav aria-label="Main" {...stylex.props(styles.nav)}>
          {nav}
        </nav>
        {actions === undefined ? null : (
          <div {...stylex.props(styles.actions)}>{actions}</div>
        )}
      </div>
    </header>
    <main id="main" tabIndex={-1} {...stylex.props(styles.main)}>
      <div {...stylex.props(column.column)}>{children}</div>
    </main>
  </div>
);

export interface AppShellNavLinkProps extends useRender.ComponentProps<"a"> {
  /** Marks the current page when the link does not do it itself. */
  readonly active?: boolean;
}

/**
 * A top bar link. Pass a router link as `render` (TanStack's `<Link>` sets
 * `aria-current="page"` when active); `active` sets it by hand.
 */
export const AppShellNavLink = ({
  active,
  render,
  ...props
}: AppShellNavLinkProps) =>
  useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        ...stylex.props(styles.navLink, shared.focusRing),
        "aria-current": active === true ? "page" : undefined,
      },
      props
    ),
    render,
  });
