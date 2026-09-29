import * as stylex from "@stylexjs/stylex";
import { Link, useRouterState } from "@tanstack/react-router";

import { CenteredScreen } from "../components/centered-screen.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { buttonStyles } from "../components/ui/button.tsx";
import { colors, fonts, fontSizes } from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  panel: {
    backgroundColor: colors.card,
    maxWidth: "32rem",
    width: "100%",
  },
  path: {
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
    overflowWrap: "anywhere",
  },
});

/** An unknown address (the root's not-found route), outside the shell. */
export const NotFoundPage = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  return (
    <CenteredScreen footer={<span>Error // 404</span>}>
      <EmptyState
        action={
          <Link to="/" {...buttonStyles({ variant: "outline" })}>
            Back to Kanshi
          </Link>
        }
        description={
          <>
            Nothing answers at{" "}
            <code {...stylex.props(styles.path)}>{pathname}</code>.
          </>
        }
        heading="h1"
        style={styles.panel}
        title="Signal lost"
      />
    </CenteredScreen>
  );
};
