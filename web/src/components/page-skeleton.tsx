import * as stylex from "@stylexjs/stylex";

import { colors, space } from "../theme/tokens.stylex.ts";
import { Skeleton } from "./ui/skeleton.tsx";

const styles = stylex.create({
  card: { height: "5.5rem" },
  cards: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  },
  eyebrow: { height: "0.6875rem", width: "6rem" },
  header: {
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingBottom: space.lg,
  },
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  row: { height: "2.5rem" },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  title: { height: "1.625rem", width: "14rem" },
});

export interface PageSkeletonProps {
  /** Stat cards above the rows. Default 0. */
  readonly cards?: number;
  /** Table-like rows. Default 5. */
  readonly rows?: number;
}

/**
 * A page loading: a header, optional stat cards and rows. The router shows
 * it while a route's loader runs (`pendingComponent`); pages can reuse it
 * or the `Skeleton` pieces for a section still loading.
 */
export const PageSkeleton = ({ cards = 0, rows = 5 }: PageSkeletonProps) => (
  <output aria-busy aria-label="Loading" {...stylex.props(styles.root)}>
    <div {...stylex.props(styles.header)}>
      <Skeleton style={styles.eyebrow} />
      <Skeleton style={styles.title} />
    </div>
    {cards === 0 ? null : (
      <div {...stylex.props(styles.cards)}>
        {Array.from({ length: cards }, (_, index) => (
          <Skeleton key={index} style={styles.card} />
        ))}
      </div>
    )}
    <div {...stylex.props(styles.rows)}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} style={styles.row} />
      ))}
    </div>
  </output>
);
