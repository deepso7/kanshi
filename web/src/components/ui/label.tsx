import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { colors } from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

const styles = stylex.create({
  label: {
    color: colors.foreground,
    cursor: "default",
    display: "inline-flex",
    gap: "0.375rem",
  },
});

export type LabelProps = Omit<
  ComponentProps<"label">,
  "className" | "style"
> & {
  readonly style?: stylex.StyleXStyles;
};

/**
 * A standalone label (`htmlFor` a control). Inside a `Field`, use
 * `FieldLabel`, which links itself.
 */
export const Label = ({ children, htmlFor, style, ...props }: LabelProps) => (
  <label
    htmlFor={htmlFor}
    {...props}
    {...stylex.props(shared.label, styles.label, style)}
  >
    {children}
  </label>
);
