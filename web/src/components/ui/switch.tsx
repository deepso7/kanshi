import { Switch as BaseSwitch } from "@base-ui/react/switch";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { colors, motion, radius } from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

const styles = stylex.create({
  root: {
    alignItems: "center",
    backgroundColor: {
      ":is([data-checked])": colors.primary,
      default: colors.muted,
    },
    borderColor: {
      ":is([data-checked])": colors.primary,
      default: colors.input,
    },
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    cursor: { ":is([data-disabled])": "not-allowed", default: "pointer" },
    display: "inline-flex",
    flexShrink: 0,
    height: "1.25rem",
    opacity: { ":is([data-disabled])": 0.5, default: 1 },
    padding: "2px",
    transitionDuration: motion.normal,
    transitionProperty: "background-color, border-color",
    width: "2.25rem",
  },
  thumb: {
    backgroundColor: {
      ":is([data-checked])": colors.primaryForeground,
      default: colors.foreground,
    },
    borderRadius: radius.sm,
    display: "block",
    height: "0.875rem",
    transform: {
      ":is([data-checked])": "translateX(1rem)",
      default: "translateX(0)",
    },
    transitionDuration: motion.normal,
    transitionProperty: "transform, background-color",
    transitionTimingFunction: motion.ease,
    width: "0.875rem",
  },
});

export type SwitchProps = Omit<
  ComponentProps<typeof BaseSwitch.Root>,
  "className" | "style"
> & {
  readonly style?: stylex.StyleXStyles;
};

/** An on/off switch (Base UI; `role="switch"`, a hidden input for forms). */
export const Switch = ({ style, ...props }: SwitchProps) => (
  <BaseSwitch.Root
    {...props}
    {...stylex.props(styles.root, shared.focusRing, style)}
  >
    <BaseSwitch.Thumb {...stylex.props(styles.thumb)} />
  </BaseSwitch.Root>
);
