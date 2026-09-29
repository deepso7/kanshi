import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { colors, motion, radius } from "../../theme/tokens.stylex.ts";
import { CheckIcon, MinusIcon } from "./icons.tsx";
import { shared } from "./shared.ts";

const styles = stylex.create({
  icon: {
    height: "0.75rem",
    width: "0.75rem",
  },
  indicator: {
    display: "flex",
  },
  root: {
    alignItems: "center",
    backgroundColor: {
      ":is([data-checked])": colors.primary,
      ":is([data-indeterminate])": colors.primary,
      default: "transparent",
    },
    borderColor: {
      ":hover": colors.foreground,
      ":is([data-checked])": colors.primary,
      ":is([data-invalid])": colors.danger,
      default: colors.input,
    },
    borderRadius: radius.sm,
    borderStyle: "solid",
    borderWidth: "1px",
    color: colors.primaryForeground,
    cursor: { ":is([data-disabled])": "not-allowed", default: "pointer" },
    display: "inline-flex",
    flexShrink: 0,
    height: "1rem",
    justifyContent: "center",
    opacity: { ":is([data-disabled])": 0.5, default: 1 },
    padding: 0,
    transitionDuration: motion.fast,
    transitionProperty: "background-color, border-color",
    width: "1rem",
  },
});

export type CheckboxProps = Omit<
  ComponentProps<typeof BaseCheckbox.Root>,
  "className" | "style"
> & {
  readonly style?: stylex.StyleXStyles;
};

/** A checkbox (Base UI; `indeterminate` shows a dash). */
export const Checkbox = ({ indeterminate, style, ...props }: CheckboxProps) => (
  <BaseCheckbox.Root
    indeterminate={indeterminate}
    {...props}
    {...stylex.props(styles.root, shared.focusRing, style)}
  >
    <BaseCheckbox.Indicator {...stylex.props(styles.indicator)}>
      {indeterminate === true ? (
        <MinusIcon {...stylex.props(styles.icon)} />
      ) : (
        <CheckIcon {...stylex.props(styles.icon)} />
      )}
    </BaseCheckbox.Indicator>
  </BaseCheckbox.Root>
);
