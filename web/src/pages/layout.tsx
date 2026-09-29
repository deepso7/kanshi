import * as stylex from "@stylexjs/stylex";
import { Link, Outlet } from "@tanstack/react-router";

import { colors, fonts, space } from "../theme/tokens.stylex.ts";

const styles = stylex.create({
  app: {
    backgroundColor: colors.background,
    color: colors.foreground,
    fontFamily: fonts.sans,
    fontSize: "15px",
    lineHeight: 1.5,
    minHeight: "100vh",
  },
  main: {
    marginInline: "auto",
    maxWidth: "1040px",
    padding: space.xl,
  },
});

/** The shell around every page. */
export const RootLayout = () => (
  <div {...stylex.props(styles.app)}>
    <main {...stylex.props(styles.main)}>
      <Outlet />
    </main>
  </div>
);

export const NotFound = () => (
  <div>
    <h1>Not found</h1>
    <Link to="/">Back to Kanshi</Link>
  </div>
);
