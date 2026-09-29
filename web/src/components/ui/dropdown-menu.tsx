import { Menu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { menuStyles as styles } from "./menu-styles.ts";
import { shared } from "./shared.ts";

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

const local = stylex.create({
  label: {
    paddingBlock: "0.375rem",
    paddingInline: "0.5rem",
  },
  popup: { minWidth: "11rem" },
  shortcut: {
    color: "inherit",
    marginLeft: "auto",
    opacity: 0.7,
  },
});

/** Root (open state); `modal={false}` keeps the page interactive. */
export const DropdownMenu = Menu.Root;

/** `render={<Button variant="ghost" size="icon" />}` for a styled trigger. */
export const DropdownMenuTrigger = Menu.Trigger;

export const DropdownMenuGroup = Menu.Group;

export type DropdownMenuContentProps = Styled<
  ComponentProps<typeof Menu.Popup>
> &
  Pick<ComponentProps<typeof Menu.Positioner>, "align" | "side" | "sideOffset">;

/** The menu panel, positioned against the trigger, in a portal. */
export const DropdownMenuContent = ({
  align = "end",
  side = "bottom",
  sideOffset = 4,
  style,
  ...props
}: DropdownMenuContentProps) => (
  <Menu.Portal>
    <Menu.Positioner
      align={align}
      side={side}
      sideOffset={sideOffset}
      {...stylex.props(styles.positioner)}
    >
      <Menu.Popup
        {...props}
        {...stylex.props(shared.popup, local.popup, style)}
      />
    </Menu.Positioner>
  </Menu.Portal>
);

export type DropdownMenuItemProps = Styled<ComponentProps<typeof Menu.Item>> & {
  readonly variant?: "default" | "destructive";
};

export const DropdownMenuItem = ({
  style,
  variant = "default",
  ...props
}: DropdownMenuItemProps) => (
  <Menu.Item
    {...props}
    {...stylex.props(
      styles.item,
      variant === "destructive" && styles.destructive,
      style
    )}
  />
);

/** A heading inside a `DropdownMenuGroup`. */
export const DropdownMenuLabel = ({
  style,
  ...props
}: Styled<ComponentProps<typeof Menu.GroupLabel>>) => (
  <Menu.GroupLabel
    {...props}
    {...stylex.props(shared.label, local.label, style)}
  />
);

export const DropdownMenuSeparator = ({
  style,
  ...props
}: Styled<ComponentProps<typeof Menu.Separator>>) => (
  <Menu.Separator {...props} {...stylex.props(styles.separator, style)} />
);

/** A keyboard hint at the end of an item. */
export const DropdownMenuShortcut = ({
  style,
  ...props
}: Styled<ComponentProps<"span">>) => (
  <span {...props} {...stylex.props(shared.label, local.shortcut, style)} />
);
