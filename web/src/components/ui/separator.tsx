import { Separator as BaseSeparator } from "@base-ui/react/separator";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { colors } from "../../theme/tokens.stylex.ts";

const styles = stylex.create({
  base: {
    backgroundColor: colors.border,
    flexShrink: 0,
  },
  horizontal: { height: "1px", width: "100%" },
  vertical: { alignSelf: "stretch", width: "1px" },
});

export type SeparatorProps = Omit<
  ComponentProps<typeof BaseSeparator>,
  "className" | "style"
> & {
  readonly style?: stylex.StyleXStyles;
};

/** A thin rule (Base UI; `orientation="vertical"` for a divider). */
export const Separator = ({
  orientation = "horizontal",
  style,
  ...props
}: SeparatorProps) => (
  <BaseSeparator
    orientation={orientation}
    {...props}
    {...stylex.props(styles.base, styles[orientation], style)}
  />
);
