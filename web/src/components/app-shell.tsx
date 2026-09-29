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
  tracking,
} from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";

const styles = stylex.create({
  brand: {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    letterSpacing: tracking.wider,
    paddingInline: { default: 0, [media.md]: space.sm },
    textTransform: "uppercase",
  },
  content: {
    marginInline: "auto",
    maxWidth: "72rem",
  },
  footer: {
    alignItems: "center",
    borderTopColor: colors.sidebarBorder,
    borderTopStyle: "solid",
    borderTopWidth: { default: 0, [media.md]: "1px" },
    display: "flex",
    flexShrink: 0,
    gap: space.sm,
    justifyContent: "space-between",
    paddingTop: { default: 0, [media.md]: space.md },
  },
  main: {
    minWidth: 0,
    paddingBlock: { default: space.xl, [media.md]: space.xxl },
    paddingInline: { default: space.lg, [media.md]: space.xxl },
  },
  nav: {
    display: "flex",
    flexDirection: { default: "row", [media.md]: "column" },
    flexGrow: 1,
    gap: "1px",
    minWidth: 0,
    overflowX: { default: "auto", [media.md]: "visible" },
  },
  navLabel: {
    display: { default: "none", [media.md]: "block" },
    paddingBottom: space.xs,
    paddingInline: space.sm,
  },
  navLink: {
    // The square marker: hollow, filled on the current page.
    "::before": {
      backgroundColor: {
        ":is([aria-current=page])": "currentColor",
        default: "transparent",
      },
      borderColor: "currentColor",
      borderStyle: "solid",
      borderWidth: "1px",
      content: '""',
      flexShrink: 0,
      height: "0.4375rem",
      opacity: { ":is([aria-current=page])": 1, default: 0.6 },
      width: "0.4375rem",
    },
    alignItems: "center",
    backgroundColor: {
      ":hover": colors.sidebarAccent,
      ":is([aria-current=page])": colors.sidebarPrimary,
      default: "transparent",
    },
    borderRadius: radius.sm,
    color: {
      ":is([aria-current=page])": colors.sidebarPrimaryForeground,
      default: colors.sidebarForeground,
    },
    display: "flex",
    flexShrink: 0,
    fontSize: fontSizes.sm,
    gap: space.sm,
    height: "2rem",
    paddingInline: space.sm,
    textDecoration: "none",
    transitionDuration: motion.fast,
    transitionProperty: "background-color, color",
    whiteSpace: "nowrap",
  },
  shell: {
    backgroundColor: colors.background,
    color: colors.foreground,
    display: "grid",
    fontSize: fontSizes.md,
    gridTemplateColumns: { default: "1fr", [media.md]: "15rem 1fr" },
    // minmax: the sidebar's own height must not size the row.
    gridTemplateRows: {
      default: "auto minmax(0, 1fr)",
      [media.md]: "minmax(0, 1fr)",
    },
    minHeight: "100dvh",
  },
  sidebar: {
    alignItems: { default: "center", [media.md]: "stretch" },
    backgroundColor: colors.sidebar,
    borderBottomColor: colors.sidebarBorder,
    borderBottomStyle: "solid",
    borderBottomWidth: { default: "1px", [media.md]: 0 },
    borderRightColor: colors.sidebarBorder,
    borderRightStyle: "solid",
    borderRightWidth: { default: 0, [media.md]: "1px" },
    color: colors.sidebarForeground,
    display: "flex",
    flexDirection: { default: "row", [media.md]: "column" },
    gap: { default: space.md, [media.md]: space.lg },
    // The viewport's height, or less inside a shorter container.
    height: { default: "auto", [media.md]: "100dvh" },
    maxHeight: "100%",
    paddingBlock: { default: space.sm, [media.md]: space.lg },
    paddingInline: { default: space.md, [media.md]: space.md },
    position: "sticky",
    top: 0,
    zIndex: 10,
  },
});

const logo = stylex.create({
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
});

export interface AppShellProps {
  /** Top of the sidebar. Default: the Kanshi mark and name. */
  readonly brand?: ReactNode;
  /** After the brand: a small tag such as a "Dev" badge. */
  readonly brandBadge?: ReactNode;
  /** `AppShellNavLink`s. */
  readonly nav: ReactNode;
  /** Bottom of the sidebar: the theme toggle, a sign-out button. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/**
 * The signed-in layout: a sidebar (brand, navigation, footer) beside the
 * page on wide screens, a top bar on narrow ones.
 */
export const AppShell = ({
  brand,
  brandBadge,
  children,
  footer,
  nav,
  style,
}: AppShellProps) => (
  <div {...stylex.props(styles.shell, style)}>
    <aside {...stylex.props(styles.sidebar)}>
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
        <span {...stylex.props(shared.label, styles.navLabel)}>Navigation</span>
        {nav}
      </nav>
      {footer === undefined ? null : (
        <div {...stylex.props(styles.footer)}>{footer}</div>
      )}
    </aside>
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.content)}>{children}</div>
    </main>
  </div>
);

export interface AppShellNavLinkProps extends useRender.ComponentProps<"a"> {
  /** Marks the current page when the link does not do it itself. */
  readonly active?: boolean;
}

/**
 * A sidebar link. Pass a router link as `render` (TanStack's `<Link>` sets
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
