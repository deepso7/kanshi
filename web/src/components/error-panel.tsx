import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { describeError } from "../api/errors.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  radius,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";
import { Button } from "./ui/button.tsx";
import { shared } from "./ui/shared.ts";

const styles = stylex.create({
  actions: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space.sm,
    marginTop: space.sm,
  },
  code: {
    color: colors.dangerForeground,
    fontFamily: fonts.mono,
  },
  message: {
    color: colors.foreground,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    margin: 0,
    maxWidth: "40rem",
    overflowWrap: "anywhere",
  },
  root: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    borderLeftWidth: "3px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    paddingBlock: space.lg,
    paddingInline: space.lg,
  },
  title: {
    color: colors.dangerForeground,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
});

export interface ErrorPanelProps {
  /** Any error an API call rejected with. */
  readonly error: Error;
  /** Shows a Retry button (e.g. `query.refetch`, `router.invalidate`). */
  readonly onRetry?: () => void;
  /** More actions next to Retry (a link back). */
  readonly actions?: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/**
 * A failed read or route, explained: the error's title, the API's
 * message, the HTTP status and a retry. Use it for a whole route (the
 * router's `errorComponent`) or for one section whose query failed.
 */
export const ErrorPanel = ({
  actions,
  error,
  onRetry,
  style,
}: ErrorPanelProps) => {
  const view = describeError(error);
  return (
    <div role="alert" {...stylex.props(styles.root, style)}>
      <span {...stylex.props(shared.label)}>
        Error
        {view.status === null ? null : (
          <span {...stylex.props(styles.code)}>{` // ${view.status}`}</span>
        )}
      </span>
      <h2 {...stylex.props(styles.title)}>{view.title}</h2>
      <p {...stylex.props(styles.message)}>{view.message}</p>
      {onRetry === undefined && actions === undefined ? null : (
        <div {...stylex.props(styles.actions)}>
          {onRetry === undefined ? null : (
            <Button onClick={onRetry} size="sm" variant="outline">
              Retry
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
};
