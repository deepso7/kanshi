import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ChannelView } from "../../../src/domain/channel.ts";
import {
  channelsQuery,
  metaQuery,
  testChannelMutation,
} from "../api/queries.ts";
import {
  AddChannelDialog,
  DeleteChannelDialog,
  EditChannelDialog,
} from "../components/channels/channel-dialogs.tsx";
import {
  channelKindLabels,
  describeTestResult,
} from "../components/channels/channel-form.ts";
import {
  ChannelKindIcon,
  ChannelKindMark,
} from "../components/channels/channel-kind.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { RelativeTime } from "../components/relative-time.tsx";
import { Button } from "../components/ui/button.tsx";
import { CloseIcon, PlusIcon } from "../components/ui/icons.tsx";
import { shared } from "../components/ui/shared.ts";
import { SimpleTooltip } from "../components/ui/tooltip.tsx";
import { useNow } from "../lib/use-now.ts";
import { useToastMutation } from "../lib/use-toast-mutation.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  media,
  radius,
  shadows,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";

const blink = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.25 },
});

const styles = stylex.create({
  actions: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: space.xs,
    gridColumn: { default: "1 / -1", [media.md]: "auto" },
    justifyContent: { default: "flex-start", [media.md]: "flex-end" },
    paddingLeft: { default: "3.25rem", [media.md]: 0 },
  },
  bar: {
    alignItems: "center",
    backgroundColor: colors.secondary,
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    color: colors.foreground,
    display: "flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gap: space.md,
    justifyContent: "space-between",
    letterSpacing: tracking.wider,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    textTransform: "uppercase",
  },
  barCount: {
    opacity: 0.8,
    whiteSpace: "nowrap",
  },
  deleteButton: {
    color: {
      ":hover": colors.dangerForeground,
      default: colors.mutedForeground,
    },
  },
  headline: {
    alignItems: "center",
    columnGap: space.sm,
    display: "flex",
    flexWrap: "wrap",
    rowGap: space.xs,
  },
  item: {
    borderBottomColor: colors.border,
    borderBottomStyle: "solid",
    borderBottomWidth: { ":last-child": 0, default: "1px" },
    display: "flex",
    flexDirection: "column",
    paddingBlock: space.lg,
    paddingInline: space.lg,
  },
  kindTag: {
    alignItems: "center",
    color: colors.mutedForeground,
    display: "inline-flex",
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    gap: space.xs,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    minWidth: 0,
  },
  meta: {
    color: colors.mutedForeground,
    display: "flex",
    flexWrap: "wrap",
    fontSize: fontSizes.xs,
    gap: space.md,
  },
  name: {
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
    lineHeight: lineHeights.tight,
    margin: 0,
    overflowWrap: "anywhere",
  },
  panel: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.sm,
    color: colors.cardForeground,
    overflow: "hidden",
  },
  result: {
    alignItems: "flex-start",
    borderLeftWidth: "3px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    fontSize: fontSizes.sm,
    gap: space.sm,
    lineHeight: lineHeights.normal,
    marginLeft: { default: 0, [media.md]: "3.25rem" },
    marginTop: space.md,
    paddingBlock: space.sm,
    paddingLeft: space.md,
    paddingRight: space.xs,
  },
  resultBody: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space.xxs,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  resultClose: {
    height: "1.5rem",
    width: "1.5rem",
  },
  resultDetail: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
  },
  resultFailed: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    color: colors.dangerForeground,
  },
  resultOk: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.successForeground,
  },
  resultPending: {
    backgroundColor: colors.muted,
    borderColor: colors.border,
    color: colors.mutedForeground,
  },
  resultTime: {
    fontWeight: fontWeights.normal,
    marginLeft: "auto",
    opacity: 0.8,
    textTransform: "none",
  },
  resultTitle: {
    alignItems: "center",
    display: "flex",
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
  },
  row: {
    alignItems: "center",
    columnGap: space.md,
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [media.md]: "auto minmax(0, 1fr) auto",
    },
    rowGap: space.md,
  },
  signalDot: {
    backgroundColor: "currentColor",
    flexShrink: 0,
    height: "0.4375rem",
    width: "0.4375rem",
  },
  signalDotBusy: {
    animationDuration: "0.9s",
    animationIterationCount: "infinite",
    animationName: {
      "@media (prefers-reduced-motion: reduce)": "none",
      default: blink,
    },
    animationTimingFunction: "steps(2, jump-none)",
  },
  url: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const SendIcon = () => (
  <svg
    aria-hidden
    fill="none"
    focusable="false"
    height="14"
    stroke="currentColor"
    strokeLinecap="square"
    strokeWidth="1.5"
    viewBox="0 0 16 16"
    width="14"
  >
    <path d="M2 8h9M8 4.5 11.5 8 8 11.5M14 3v10" />
  </svg>
);

const TrashIcon = () => (
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
  >
    <path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.75 9h6.5l.75-9M6.75 7v4M9.25 7v4" />
  </svg>
);

const BellIcon = () => (
  <svg
    aria-hidden
    fill="none"
    focusable="false"
    height="28"
    stroke="currentColor"
    strokeLinecap="square"
    strokeWidth="1.25"
    viewBox="0 0 16 16"
    width="28"
  >
    <path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z" />
    <path d="M6.75 14h2.5" />
  </svg>
);

const pad = (count: number) => String(count).padStart(2, "0");

interface ChannelRowProps {
  readonly channel: ChannelView;
  readonly now: number;
  readonly onEdit: (channel: ChannelView) => void;
  readonly onDelete: (channel: ChannelView) => void;
}

/** One channel: what it is, where it points (masked), and its actions. */
const ChannelRow = ({ channel, now, onDelete, onEdit }: ChannelRowProps) => {
  const test = useToastMutation(testChannelMutation, {
    error: "Could not send the test alert",
  });
  const [testedAt, setTestedAt] = useState<number | null>(null);
  const outcome =
    test.data === undefined ? null : describeTestResult(test.data);
  const nameId = `channel-${channel.id}-name`;

  return (
    <li aria-labelledby={nameId} {...stylex.props(styles.item)}>
      <div {...stylex.props(styles.row)}>
        <ChannelKindMark kind={channel.kind} />
        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.headline)}>
            <h2 id={nameId} {...stylex.props(styles.name)}>
              {channel.name}
            </h2>
            <span {...stylex.props(styles.kindTag)}>
              <ChannelKindIcon height="12" kind={channel.kind} width="12" />
              {channelKindLabels[channel.kind]}
            </span>
          </div>
          <span
            aria-label="URL (masked)"
            title={channel.maskedUrl}
            {...stylex.props(styles.url)}
          >
            {channel.maskedUrl}
          </span>
          <div {...stylex.props(styles.meta)}>
            <span>
              Updated <RelativeTime at={channel.updatedAt} now={now} />
            </span>
          </div>
        </div>
        <div {...stylex.props(styles.actions)}>
          <Button
            // Each card has these buttons: name the channel for AT.
            aria-label={
              test.isPending ? undefined : `Send test to ${channel.name}`
            }
            disabled={test.isPending}
            onClick={() =>
              test.mutate(channel.id, {
                onSettled: () => setTestedAt(Date.now()),
              })
            }
            size="sm"
            variant="outline"
          >
            <SendIcon />
            {test.isPending ? "Sending…" : "Send test"}
          </Button>
          <Button
            aria-label={`Edit ${channel.name}`}
            onClick={() => onEdit(channel)}
            size="sm"
            variant="ghost"
          >
            Edit
          </Button>
          <SimpleTooltip content="Delete channel">
            <Button
              aria-label={`Delete ${channel.name}`}
              onClick={() => onDelete(channel)}
              size="icon"
              style={styles.deleteButton}
              variant="ghost"
            >
              <TrashIcon />
            </Button>
          </SimpleTooltip>
        </div>
      </div>
      <div aria-live="polite">
        {test.isPending ? (
          <div {...stylex.props(styles.result, styles.resultPending)}>
            <div {...stylex.props(styles.resultBody)}>
              <span {...stylex.props(styles.resultTitle)}>
                <span
                  aria-hidden
                  {...stylex.props(styles.signalDot, styles.signalDotBusy)}
                />
                Sending test alert
              </span>
            </div>
          </div>
        ) : null}
        {!test.isPending && outcome !== null ? (
          <div
            data-delivered={outcome.delivered}
            {...stylex.props(
              styles.result,
              outcome.delivered ? styles.resultOk : styles.resultFailed
            )}
          >
            <div {...stylex.props(styles.resultBody)}>
              <span {...stylex.props(styles.resultTitle)}>
                <span aria-hidden {...stylex.props(styles.signalDot)} />
                {outcome.title}
                {testedAt === null ? null : (
                  <RelativeTime
                    at={testedAt}
                    now={Math.max(now, testedAt)}
                    {...stylex.props(styles.resultTime)}
                  />
                )}
              </span>
              <span {...stylex.props(styles.resultDetail)}>
                {outcome.detail}
              </span>
            </div>
            <Button
              aria-label="Dismiss the test result"
              onClick={() => test.reset()}
              size="icon"
              style={styles.resultClose}
              variant="ghost"
            >
              <CloseIcon height="14" width="14" />
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
};

/** `/channels`: where alerts go; add, edit, test and delete channels. */
export const ChannelsPage = () => {
  const { data: channels } = useSuspenseQuery(channelsQuery);
  const { data: meta } = useSuspenseQuery(metaQuery);
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ChannelView | null>(null);
  const [deleting, setDeleting] = useState<ChannelView | null>(null);

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon />
      Add channel
    </Button>
  );

  return (
    <>
      <PageHeader
        actions={channels.length === 0 ? undefined : addButton}
        description="Where alerts go when a monitor goes down or recovers. Monitors alert every channel unless they list their own. URLs are secrets: stored, never shown again."
        eyebrow="Alerts"
        title="Channels"
      />
      {channels.length === 0 ? (
        <EmptyState
          action={addButton}
          description="Add a Slack, Discord, ntfy or webhook channel, and monitors alert it when they go down or recover."
          heading="h2"
          icon={<BellIcon />}
          title="No channels yet"
        />
      ) : (
        <section aria-label="Alert channels" {...stylex.props(styles.panel)}>
          <div aria-hidden {...stylex.props(styles.bar)}>
            <span>Alert routing</span>
            <span {...stylex.props(styles.barCount)}>
              {`[ ${pad(channels.length)} ]`}
            </span>
          </div>
          <span {...stylex.props(shared.srOnly)}>
            {channels.length === 1
              ? "1 channel"
              : `${channels.length} channels`}
          </span>
          <ul {...stylex.props(styles.list)}>
            {channels.map((channel) => (
              <ChannelRow
                channel={channel}
                key={channel.id}
                now={now}
                onDelete={setDeleting}
                onEdit={setEditing}
              />
            ))}
          </ul>
        </section>
      )}
      <AddChannelDialog
        devMode={meta.devMode}
        onOpenChange={setAdding}
        open={adding}
      />
      <EditChannelDialog
        channel={editing}
        devMode={meta.devMode}
        onClose={() => setEditing(null)}
      />
      <DeleteChannelDialog
        channel={deleting}
        onClose={() => setDeleting(null)}
      />
    </>
  );
};
