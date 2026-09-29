import { Link } from "@tanstack/react-router";

import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { buttonStyles } from "../components/ui/button.tsx";
import { PlusIcon } from "../components/ui/icons.tsx";

/** `/`: every monitor, its status and recent activity. Placeholder. */
export const DashboardPage = () => (
  <>
    <PageHeader
      actions={
        <Link to="/monitors/new" {...buttonStyles({})}>
          <PlusIcon /> New monitor
        </Link>
      }
      description="Everything Kanshi watches, and how it is doing."
      eyebrow="Overview"
      title="Monitors"
    />
    <EmptyState
      description="The dashboard is being ported to the new UI."
      title="Coming soon"
    />
  </>
);
