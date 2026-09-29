import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, JSX } from "react";

import { colors, fontSizes, motion, space } from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

const styles = stylex.create({
  bodyRow: {
    backgroundColor: {
      ":hover": colors.accent,
      ":is([data-state=selected])": colors.muted,
      default: "transparent",
    },
  },
  caption: {
    captionSide: "bottom",
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    marginTop: space.md,
    textAlign: "start",
  },
  cell: {
    paddingBlock: space.sm,
    paddingInline: space.md,
    verticalAlign: "middle",
  },
  footer: {
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    fontWeight: 500,
  },
  head: {
    height: "2.25rem",
    paddingInline: space.md,
    textAlign: "start",
    verticalAlign: "middle",
    whiteSpace: "nowrap",
  },
  header: {
    borderBottomColor: colors.foreground,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
  },
  row: {
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: { ":last-child": "0", default: "1px" },
    transitionDuration: motion.fast,
    transitionProperty: "background-color",
  },
  table: {
    borderCollapse: "collapse",
    fontSize: fontSizes.sm,
    fontVariantNumeric: "tabular-nums",
    width: "100%",
  },
  wrapper: {
    overflowX: "auto",
    width: "100%",
  },
});

type Styled<T extends keyof JSX.IntrinsicElements> = Omit<
  ComponentProps<T>,
  "className" | "style"
> & {
  readonly style?: stylex.StyleXStyles;
};

/** A data table; the wrapper scrolls horizontally on narrow screens. */
export const Table = ({ style, ...props }: Styled<"table">) => (
  <div {...stylex.props(styles.wrapper)}>
    <table {...props} {...stylex.props(styles.table, style)} />
  </div>
);

export const TableHeader = ({ style, ...props }: Styled<"thead">) => (
  <thead {...props} {...stylex.props(styles.header, style)} />
);

export const TableBody = (
  props: Omit<ComponentProps<"tbody">, "className" | "style">
) => <tbody {...props} />;

export const TableFooter = ({ style, ...props }: Styled<"tfoot">) => (
  <tfoot {...props} {...stylex.props(styles.footer, style)} />
);

/** `header` rows (inside `TableHeader`) get no hover. */
export const TableRow = ({
  header = false,
  style,
  ...props
}: Styled<"tr"> & { readonly header?: boolean }) => (
  <tr
    {...props}
    {...stylex.props(styles.row, !header && styles.bodyRow, style)}
  />
);

export const TableHead = ({ style, ...props }: Styled<"th">) => (
  <th
    scope="col"
    {...props}
    {...stylex.props(shared.label, styles.head, style)}
  />
);

export const TableCell = ({ style, ...props }: Styled<"td">) => (
  <td {...props} {...stylex.props(styles.cell, style)} />
);

export const TableCaption = ({ style, ...props }: Styled<"caption">) => (
  <caption {...props} {...stylex.props(styles.caption, style)} />
);
