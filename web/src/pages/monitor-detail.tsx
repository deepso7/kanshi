import { getRouteApi } from "@tanstack/react-router";

import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";

const route = getRouteApi("/_app/monitors/$id");

/** `/monitors/$id`: one monitor's state, history and actions. Placeholder. */
export const MonitorDetailPage = () => {
  const { id } = route.useParams();
  return (
    <>
      <PageHeader eyebrow="Monitor" title={id} />
      <EmptyState
        description="The monitor page is being ported to the new UI."
        title="Coming soon"
      />
    </>
  );
};
