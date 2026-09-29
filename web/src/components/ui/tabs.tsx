import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  motion,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

const styles = stylex.create({
  indicator: {
    backgroundColor: colors.foreground,
    bottom: "-1px",
    height: "2px",
    left: 0,
    position: "absolute",
    transform: "translateX(var(--active-tab-left))",
    transitionDuration: motion.normal,
    transitionProperty: "transform, width",
    transitionTimingFunction: motion.ease,
    width: "var(--active-tab-width)",
  },
  list: {
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    display: "flex",
    gap: space.xs,
    position: "relative",
  },
  panel: {
    outlineOffset: "4px",
  },
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  tab: {
    alignItems: "center",
    backgroundColor: {
      ":hover": colors.accent,
      default: "transparent",
    },
    borderStyle: "none",
    color: {
      ":hover": colors.foreground,
      ":is([data-active])": colors.foreground,
      default: colors.mutedForeground,
    },
    cursor: { ":is([data-disabled])": "not-allowed", default: "pointer" },
    display: "inline-flex",
    fontFamily: "inherit",
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    gap: space.xs,
    height: "2.25rem",
    letterSpacing: tracking.wide,
    opacity: { ":is([data-disabled])": 0.5, default: 1 },
    outlineOffset: "-2px",
    paddingInline: space.md,
    textTransform: "uppercase",
    transitionDuration: motion.fast,
    transitionProperty: "background-color, color",
  },
});

/** Root: `value` / `defaultValue` / `onValueChange`. */
export const Tabs = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Root>>) => (
  <BaseTabs.Root {...props} {...stylex.props(styles.root, style)} />
);

/** The tab strip, with the sliding underline of the active tab. */
export const TabsList = ({
  children,
  style,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.List>>) => (
  <BaseTabs.List {...props} {...stylex.props(styles.list, style)}>
    {children}
    <BaseTabs.Indicator {...stylex.props(styles.indicator)} />
  </BaseTabs.List>
);

export const TabsTrigger = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Tab>>) => (
  <BaseTabs.Tab
    {...props}
    {...stylex.props(styles.tab, shared.focusRing, style)}
  />
);

export const TabsContent = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseTabs.Panel>>) => (
  <BaseTabs.Panel
    {...props}
    {...stylex.props(styles.panel, shared.focusRing, style)}
  />
);
