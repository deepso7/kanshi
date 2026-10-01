import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import {
  colors,
  fontSizes,
  layers,
  motion,
  radius,
  space,
} from "../../theme/tokens.stylex.ts";

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

const styles = stylex.create({
  popup: {
    backgroundColor: colors.foreground,
    borderRadius: radius.sm,
    color: colors.background,
    fontSize: fontSizes.xs,
    lineHeight: 1.4,
    maxWidth: "18rem",
    opacity: {
      ":is([data-ending-style])": 0,
      ":is([data-starting-style])": 0,
      default: 1,
    },
    paddingBlock: space.xs,
    paddingInline: space.sm,
    transitionDuration: motion.fast,
    transitionProperty: "opacity",
  },
  positioner: {
    zIndex: layers.popover,
  },
});

/** One per app: shares the open delay between neighbouring tooltips. */
export const TooltipProvider = BaseTooltip.Provider;

export const Tooltip = BaseTooltip.Root;

/** `render={<Button />}` (or any element) to attach to it. */
export const TooltipTrigger = BaseTooltip.Trigger;

export type TooltipContentProps = Styled<
  ComponentProps<typeof BaseTooltip.Popup>
> &
  Pick<
    ComponentProps<typeof BaseTooltip.Positioner>,
    "align" | "side" | "sideOffset"
  >;

/** The inverted label, in a portal. */
export const TooltipContent = ({
  align,
  side = "top",
  sideOffset = 6,
  style,
  ...props
}: TooltipContentProps) => (
  <BaseTooltip.Portal>
    <BaseTooltip.Positioner
      align={align}
      side={side}
      sideOffset={sideOffset}
      {...stylex.props(styles.positioner)}
    >
      <BaseTooltip.Popup {...props} {...stylex.props(styles.popup, style)} />
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>
);

/** The common case: a tooltip on one element. */
export const SimpleTooltip = ({
  children,
  content,
  side,
}: {
  /** The trigger element (a button, an icon link). */
  readonly children: ReactElement;
  readonly content: ReactNode;
  readonly side?: TooltipContentProps["side"];
}) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipContent side={side}>{content}</TooltipContent>
  </Tooltip>
);
