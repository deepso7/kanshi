import { getRouteApi } from "@tanstack/react-router";

import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";

const editRoute = getRouteApi("/_app/monitors/$id/edit");

/** `/monitors/new`: add a monitor. Placeholder. */
export const NewMonitorPage = () => (
  <>
    <PageHeader eyebrow="Monitors" title="New monitor" />
    <EmptyState
      description="The monitor form is being ported to the new UI."
      title="Coming soon"
    />
  </>
);

/** `/monitors/$id/edit`: change a monitor. Placeholder. */
export const EditMonitorPage = () => {
  const { id } = editRoute.useParams();
  return (
    <>
      <PageHeader eyebrow={`Monitor ${id}`} title="Edit monitor" />
      <EmptyState
        description="The monitor form is being ported to the new UI."
        title="Coming soon"
      />
    </>
  );
};
