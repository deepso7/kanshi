import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { sessionQuery } from "../api/queries.ts";
import { colors, space } from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  muted: {
    color: colors.mutedForeground,
  },
  title: {
    color: colors.foreground,
    fontSize: "2rem",
    letterSpacing: "0.02em",
    marginBlock: space.lg,
  },
});

/** Placeholder until the dashboard is ported. */
export const HomePage = () => {
  const session = useQuery(sessionQuery);
  let state = "Checking your session…";
  if (session.isError) {
    state = "Could not reach the API.";
  } else if (session.data !== undefined) {
    state = session.data.signedIn ? "Signed in." : "Not signed in.";
  }
  return (
    <>
      <h1 {...stylex.props(styles.title)}>Kanshi</h1>
      <p {...stylex.props(styles.muted)}>{state}</p>
      <p>
        <Link to="/status">Status page</Link>
      </p>
    </>
  );
};
