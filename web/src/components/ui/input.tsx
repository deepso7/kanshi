import { Input as BaseInput } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  fontSizes,
  fonts,
  motion,
  radius,
  space,
} from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

/** Shared by Input, Textarea and the Select trigger. */
export const control = stylex.create({
  base: {
    "::placeholder": {
      color: colors.placeholder,
      opacity: 0.8,
    },
    backgroundColor: {
      ":disabled": colors.muted,
      ":is([data-disabled])": colors.muted,
      default: "transparent",
    },
    borderColor: {
      ":focus-visible": colors.ring,
      ":hover": colors.foreground,
      ":is([aria-invalid=true])": colors.danger,
      ":is([data-invalid])": colors.danger,
      default: colors.input,
    },
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    color: colors.foreground,
    fontFamily: "inherit",
    fontSize: fontSizes.md,
    minWidth: 0,
    opacity: { ":disabled": 0.6, default: 1 },
    paddingInline: space.md,
    transitionDuration: motion.fast,
    transitionProperty: "border-color, background-color",
    width: "100%",
  },
  input: {
    height: "2.25rem",
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
  },
});

export type InputProps = Omit<
  ComponentProps<typeof BaseInput>,
  "className" | "style"
> & {
  /** Monospace text, for URLs, tokens and numbers. */
  readonly mono?: boolean;
  readonly style?: stylex.StyleXStyles;
};

/** A text input; inside a `Field` it is labelled and validated by it. */
export const Input = ({ mono = false, style, ...props }: InputProps) => (
  <BaseInput
    {...props}
    {...stylex.props(
      control.base,
      control.input,
      shared.focusRing,
      mono && control.mono,
      style
    )}
  />
);
