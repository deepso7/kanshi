import * as stylex from "@stylexjs/stylex";

import { EmptyState } from "../components/empty-state.tsx";
import { PageHeader } from "../components/page-header.tsx";
import { space } from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  page: {
    marginInline: "auto",
    maxWidth: "56rem",
    paddingBlock: space.xxl,
    paddingInline: space.lg,
  },
});

/**
 * `/status`: the public status page (no session, no app shell; it gets
 * its own minimal layout). Placeholder.
 */
export const StatusPage = () => (
  <div {...stylex.props(styles.page)}>
    <PageHeader eyebrow="Public" title="Status" />
    <EmptyState
      description="The status page is being ported to the new UI."
      title="Coming soon"
    />
  </div>
);
