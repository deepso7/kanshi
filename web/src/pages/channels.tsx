import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";

/** `/channels`: alert channels (add, edit, test, delete). Placeholder. */
export const ChannelsPage = () => (
  <>
    <PageHeader
      description="Where alerts go when a monitor goes down or recovers."
      eyebrow="Alerts"
      title="Channels"
    />
    <EmptyState
      description="The channels page is being ported to the new UI."
      title="Coming soon"
    />
  </>
);
