import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";

import {
  channelsQuery,
  createMonitorMutation,
  metaQuery,
  monitorQuery,
  updateMonitorMutation,
} from "../api/queries.ts";
import { MonitorForm } from "../components/monitor-form.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { buttonStyles } from "../components/ui/button.tsx";
import { useToastMutation } from "../lib/use-toast-mutation.ts";
import { colors } from "../theme/tokens.stylex.ts";

const editRoute = getRouteApi("/_app/monitors/$id/edit");

const styles = stylex.create({
  link: {
    color: colors.foreground,
    textDecorationColor: colors.border,
    textUnderlineOffset: "3px",
  },
  page: {
    maxWidth: "60rem",
  },
});

const ChannelsLink = () => (
  <Link to="/channels" {...stylex.props(styles.link)}>
    Add a channel
  </Link>
);

/** `/monitors/new`: add a monitor, then open it. */
export const NewMonitorPage = () => {
  const navigate = useNavigate();
  const { data: channels } = useSuspenseQuery(channelsQuery);
  const { data: meta } = useSuspenseQuery(metaQuery);
  const create = useToastMutation(createMonitorMutation, {
    error: false,
    success: (monitor) => `Monitor "${monitor.name}" created`,
  });
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        description="Kanshi requests the URL on a schedule and alerts your channels when it goes down and when it recovers."
        eyebrow="Monitors / New"
        title="New monitor"
      />
      <MonitorForm
        cancel={
          <Link to="/" {...buttonStyles({ variant: "ghost" })}>
            Cancel
          </Link>
        }
        channels={channels}
        channelsLink={<ChannelsLink />}
        monitor={null}
        onCreate={async (payload) => {
          const monitor = await create.mutateAsync(payload);
          await navigate({
            params: { id: monitor.id },
            to: "/monitors/$id",
          });
        }}
        onUpdate={() => Promise.resolve()}
        rules={meta}
      />
    </div>
  );
};

/** `/monitors/$id/edit`: change a monitor; only changed fields are sent. */
export const EditMonitorPage = () => {
  const { id } = editRoute.useParams();
  const navigate = useNavigate();
  const { data: monitor } = useSuspenseQuery(monitorQuery(id));
  const { data: channels } = useSuspenseQuery(channelsQuery);
  const { data: meta } = useSuspenseQuery(metaQuery);
  const update = useToastMutation(updateMonitorMutation, {
    error: false,
    success: "Changes saved",
  });
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader eyebrow="Monitors / Edit" title={monitor.name} />
      <MonitorForm
        cancel={
          <Link
            params={{ id }}
            to="/monitors/$id"
            {...buttonStyles({ variant: "ghost" })}
          >
            Cancel
          </Link>
        }
        channels={channels}
        channelsLink={<ChannelsLink />}
        // A fresh form per monitor (its initial values are read once).
        key={monitor.id}
        monitor={monitor}
        onCreate={() => Promise.resolve()}
        onUpdate={async (patch) => {
          await update.mutateAsync({ id, patch });
          await navigate({ params: { id }, to: "/monitors/$id" });
        }}
        rules={meta}
      />
    </div>
  );
};
