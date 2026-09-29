import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  lineHeights,
  motion,
  radius,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";
import { shared } from "./ui/shared.ts";

const styles = stylex.create({
  card: {
    alignItems: "flex-start",
    backgroundColor: {
      ":hover": colors.accent,
      default: "transparent",
    },
    borderColor: colors.input,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    cursor: "pointer",
    display: "flex",
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.md,
    transitionDuration: motion.fast,
    transitionProperty: "background-color, border-color",
  },
  cardSelected: {
    backgroundColor: {
      ":hover": colors.accent,
      default: colors.muted,
    },
    borderColor: colors.foreground,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.normal,
  },
  dot: {
    backgroundColor: colors.foreground,
    height: "0.375rem",
    width: "0.375rem",
  },
  group: {
    display: "grid",
    gap: space.sm,
    gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  },
  radio: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: {
      ":is([data-checked])": colors.foreground,
      default: colors.input,
    },
    borderRadius: radius.sm,
    borderStyle: "solid",
    borderWidth: "1px",
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    height: "1rem",
    justifyContent: "center",
    marginTop: "0.0625rem",
    padding: 0,
    width: "1rem",
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    minWidth: 0,
  },
  title: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.tight,
    textTransform: "uppercase",
  },
});

export type ChoiceCardsProps = Omit<
  ComponentProps<typeof RadioGroup>,
  "className" | "style"
> & {
  readonly style?: stylex.StyleXStyles;
};

/** A radio group laid out as cards (a title and a line each). */
export const ChoiceCards = ({ style, ...props }: ChoiceCardsProps) => (
  <RadioGroup {...props} {...stylex.props(styles.group, style)} />
);

export interface ChoiceCardProps {
  readonly value: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Whether it is the group's value (for the card's frame). */
  readonly selected: boolean;
}

/** One option of `ChoiceCards`; the whole card is its label. */
export const ChoiceCard = ({
  description,
  selected,
  title,
  value,
}: ChoiceCardProps) => (
  <label {...stylex.props(styles.card, selected && styles.cardSelected)}>
    <Radio.Root value={value} {...stylex.props(styles.radio, shared.focusRing)}>
      <Radio.Indicator {...stylex.props(styles.dot)} />
    </Radio.Root>
    <span {...stylex.props(styles.text)}>
      <span {...stylex.props(styles.title)}>{title}</span>
      {description === undefined ? null : (
        <span {...stylex.props(styles.description)}>{description}</span>
      )}
    </span>
  </label>
);
