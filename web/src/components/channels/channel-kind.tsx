// A channel's kind as a glyph and a tag. Glyphs are generic (no brand
// marks), drawn on the 16px grid of `ui/icons.tsx`.
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";

import type { ChannelKind } from "../../../../src/domain/channel.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  radius,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";
import { channelKindLabels } from "./channel-form.ts";

type IconProps = Omit<ComponentProps<"svg">, "children">;

const Glyph = ({
  children,
  ...props
}: IconProps & { readonly children: ReactNode }) => (
  <svg
    aria-hidden
    fill="none"
    focusable="false"
    height="16"
    stroke="currentColor"
    strokeLinecap="square"
    strokeWidth="1.5"
    viewBox="0 0 16 16"
    width="16"
    {...props}
  >
    {children}
  </svg>
);

const glyphs = {
  // A speech bubble.
  discord: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  // A bell.
  ntfy: (
    <>
      <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" />
      <path d="M6.75 14h2.5" />
    </>
  ),
  // A hash: a chat channel.
  slack: <path d="M6 2.5 5 13.5M11 2.5l-1 11M2.5 6h11M2 10.5h11" />,
  // Braces: a JSON body.
  webhook: (
    <path d="M6 2.5H5a1.5 1.5 0 0 0-1.5 1.5v2.5L2 8l1.5 1.5V12A1.5 1.5 0 0 0 5 13.5h1M10 2.5h1A1.5 1.5 0 0 1 12.5 4v2.5L14 8l-1.5 1.5V12a1.5 1.5 0 0 1-1.5 1.5h-1" />
  ),
} satisfies Record<ChannelKind, ReactNode>;

/** The kind's glyph (decorative). */
export const ChannelKindIcon = ({
  kind,
  ...props
}: IconProps & { readonly kind: ChannelKind }) => (
  <Glyph data-kind={kind} {...props}>
    {glyphs[kind]}
  </Glyph>
);

const styles = stylex.create({
  frame: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderColor: colors.foreground,
    borderRadius: radius.sm,
    borderStyle: "solid",
    borderWidth: "1px",
    color: colors.foreground,
    display: "inline-flex",
    flexShrink: 0,
    height: "2.25rem",
    justifyContent: "center",
    position: "relative",
    width: "2.25rem",
  },
  // A notch in the corner, like an item frame.
  notch: {
    backgroundColor: colors.foreground,
    bottom: "-1px",
    height: "0.3125rem",
    position: "absolute",
    right: "-1px",
    width: "0.3125rem",
  },
  tag: {
    alignItems: "center",
    color: colors.mutedForeground,
    display: "inline-flex",
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    gap: space.xs,
    letterSpacing: tracking.wide,
    lineHeight: 1,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  },
});

/** The glyph in a square frame, for a list row. */
export const ChannelKindMark = ({
  kind,
  style,
}: {
  readonly kind: ChannelKind;
  readonly style?: stylex.StyleXStyles;
}) => (
  <span aria-hidden {...stylex.props(styles.frame, style)}>
    <ChannelKindIcon kind={kind} />
    <span {...stylex.props(styles.notch)} />
  </span>
);

/** The glyph and the kind's name, inline (a select item, a caption). */
export const ChannelKindLabel = ({
  kind,
  style,
}: {
  readonly kind: ChannelKind;
  readonly style?: stylex.StyleXStyles;
}) => (
  <span {...stylex.props(styles.tag, style)}>
    <ChannelKindIcon height="14" kind={kind} width="14" />
    {channelKindLabels[kind]}
  </span>
);
