import { Select as BaseSelect } from "@base-ui/react/select";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";

import { colors, space } from "../../theme/tokens.stylex.ts";
import { CheckIcon, ChevronDownIcon } from "./icons.tsx";
import { control } from "./input.tsx";
import { menuStyles } from "./menu-styles.ts";
import { shared } from "./shared.ts";

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

const styles = stylex.create({
  icon: {
    color: colors.mutedForeground,
    display: "flex",
    flexShrink: 0,
  },
  indicator: {
    display: "flex",
    position: "absolute",
    right: space.sm,
  },
  item: {
    paddingInlineEnd: space.xl,
    position: "relative",
  },
  itemText: {
    flexGrow: 1,
  },
  popup: {
    maxHeight: "var(--available-height)",
    minWidth: "var(--anchor-width)",
    overflowY: "auto",
  },
  trigger: {
    alignItems: "center",
    backgroundColor: {
      ":is([data-popup-open])": colors.accent,
      default: "transparent",
    },
    cursor: "pointer",
    display: "inline-flex",
    gap: space.sm,
    height: "2.25rem",
    justifyContent: "space-between",
    textAlign: "start",
  },
  value: {
    color: {
      ":is([data-placeholder])": colors.placeholder,
      default: colors.foreground,
    },
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/**
 * Root: `value` / `defaultValue` / `onValueChange`, and `items` (value to
 * label) so the trigger shows the label, not the raw value. Inside a
 * `Field` it is labelled and named by it.
 */
export const Select = BaseSelect.Root;

export const SelectGroup = BaseSelect.Group;

export type SelectTriggerProps = Styled<
  ComponentProps<typeof BaseSelect.Trigger>
> & {
  readonly placeholder?: ReactNode;
};

/** The button showing the selected value; a chevron at the end. */
export const SelectTrigger = ({
  placeholder,
  style,
  ...props
}: SelectTriggerProps) => (
  <BaseSelect.Trigger
    {...props}
    {...stylex.props(control.base, styles.trigger, shared.focusRing, style)}
  >
    <BaseSelect.Value
      placeholder={placeholder}
      {...stylex.props(styles.value)}
    />
    <BaseSelect.Icon {...stylex.props(styles.icon)}>
      <ChevronDownIcon />
    </BaseSelect.Icon>
  </BaseSelect.Trigger>
);

/**
 * The list, below the trigger (not over it: `alignItemWithTrigger` would
 * inject an inline `<style>`, which the CSP forbids).
 */
export const SelectContent = ({
  children,
  style,
  ...props
}: Styled<ComponentProps<typeof BaseSelect.Popup>>) => (
  <BaseSelect.Portal>
    <BaseSelect.Positioner
      alignItemWithTrigger={false}
      sideOffset={4}
      {...stylex.props(menuStyles.positioner)}
    >
      <BaseSelect.Popup
        {...props}
        {...stylex.props(shared.popup, styles.popup, style)}
      >
        <BaseSelect.List>{children}</BaseSelect.List>
      </BaseSelect.Popup>
    </BaseSelect.Positioner>
  </BaseSelect.Portal>
);

export const SelectItem = ({
  children,
  style,
  ...props
}: Styled<ComponentProps<typeof BaseSelect.Item>>) => (
  <BaseSelect.Item
    {...props}
    {...stylex.props(menuStyles.item, styles.item, style)}
  >
    <BaseSelect.ItemText {...stylex.props(styles.itemText)}>
      {children}
    </BaseSelect.ItemText>
    <BaseSelect.ItemIndicator {...stylex.props(styles.indicator)}>
      <CheckIcon />
    </BaseSelect.ItemIndicator>
  </BaseSelect.Item>
);

export const SelectLabel = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseSelect.GroupLabel>>) => (
  <BaseSelect.GroupLabel {...props} {...stylex.props(shared.label, style)} />
);

export const SelectSeparator = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseSelect.Separator>>) => (
  <BaseSelect.Separator
    {...props}
    {...stylex.props(menuStyles.separator, style)}
  />
);
