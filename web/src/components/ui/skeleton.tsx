import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { colors, radius } from "../../theme/tokens.stylex.ts";

const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.5 },
});

const styles = stylex.create({
  skeleton: {
    animationDuration: "1.6s",
    animationIterationCount: "infinite",
    animationName: {
      "@media (prefers-reduced-motion: reduce)": "none",
      default: pulse,
    },
    animationTimingFunction: "ease-in-out",
    backgroundColor: colors.border,
    borderRadius: radius.md,
    display: "block",
    minHeight: "0.75rem",
  },
});

export type SkeletonProps = Omit<
  ComponentProps<"div">,
  "className" | "style"
> & {
  /** Size and shape (width, height) go here. */
  readonly style?: stylex.StyleXStyles;
};

/** A placeholder block while data loads; hidden from assistive tech. */
export const Skeleton = ({ style, ...props }: SkeletonProps) => (
  <div aria-hidden {...props} {...stylex.props(styles.skeleton, style)} />
);
