import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  lineHeights,
  radius,
  shadows,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";

const styles = stylex.create({
  action: {
    alignSelf: "start",
    gridColumn: 2,
    gridRow: "1 / span 2",
    justifySelf: "end",
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.sm,
    color: colors.cardForeground,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  content: {
    ":last-child": { paddingBottom: space.lg },
    paddingBlock: 0,
    paddingInline: space.lg,
  },
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    gridColumn: 1,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  footer: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    display: "flex",
    gap: space.sm,
    marginTop: space.lg,
    paddingBlock: space.md,
    paddingInline: space.lg,
  },
  header: {
    alignItems: "start",
    columnGap: space.lg,
    display: "grid",
    gridTemplateColumns: "1fr auto",
    padding: space.lg,
    paddingBottom: space.md,
    rowGap: space.xs,
  },
  title: {
    // The small square marker of panel titles.
    "::before": {
      backgroundColor: "currentColor",
      content: '""',
      flexShrink: 0,
      height: "0.4375rem",
      width: "0.4375rem",
    },
    alignItems: "center",
    display: "flex",
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    gridColumn: 1,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.tight,
    margin: 0,
    textTransform: "uppercase",
  },
});

type DivProps = Omit<ComponentProps<"div">, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

/** A bordered panel. Compose with the parts below, all optional. */
export const Card = ({ style, ...props }: DivProps) => (
  <div {...props} {...stylex.props(styles.card, style)} />
);

export const CardHeader = ({ style, ...props }: DivProps) => (
  <div {...props} {...stylex.props(styles.header, style)} />
);

/** A heading (`h3`), with the square marker. */
export const CardTitle = ({
  children,
  heading: Heading = "h3",
  style,
  ...props
}: Omit<ComponentProps<"h3">, "className" | "style"> & {
  /** The heading element: `h2` for a card that is a page section. */
  readonly heading?: "h2" | "h3";
  readonly style?: stylex.StyleXStyles;
}) => (
  <Heading {...props} {...stylex.props(styles.title, style)}>
    {children}
  </Heading>
);

export const CardDescription = ({
  style,
  ...props
}: Omit<ComponentProps<"p">, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
}) => <p {...props} {...stylex.props(styles.description, style)} />;

/** Top-right of the header: a button or a menu. */
export const CardAction = ({ style, ...props }: DivProps) => (
  <div {...props} {...stylex.props(styles.action, style)} />
);

export const CardContent = ({ style, ...props }: DivProps) => (
  <div {...props} {...stylex.props(styles.content, style)} />
);

export const CardFooter = ({ style, ...props }: DivProps) => (
  <div {...props} {...stylex.props(styles.footer, style)} />
);
