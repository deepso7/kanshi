import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { lineHeights, space } from "../../theme/tokens.stylex.ts";
import { control } from "./input.tsx";
import { shared } from "./shared.ts";

const styles = stylex.create({
  textarea: {
    lineHeight: lineHeights.normal,
    minHeight: "5rem",
    paddingBlock: space.sm,
    resize: "vertical",
  },
});

export type TextareaProps = Omit<
  ComponentProps<"textarea">,
  "className" | "style"
> & {
  readonly mono?: boolean;
  readonly style?: stylex.StyleXStyles;
};

/**
 * A multi-line input. Rendered through `Field.Control`, so a surrounding
 * `Field` labels and validates it like an `Input`.
 */
export const Textarea = ({ mono = false, style, ...props }: TextareaProps) => (
  <Field.Control
    render={
      <textarea
        {...props}
        {...stylex.props(
          control.base,
          styles.textarea,
          shared.focusRing,
          mono && control.mono,
          style
        )}
      />
    }
  />
);
