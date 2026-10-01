import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import { Link, getRouteApi, useNavigate } from "@tanstack/react-router";
import type { FormEvent } from "react";
import { useState } from "react";

import { describeError, isUnauthorized } from "../api/errors.ts";
import { signInMutation } from "../api/queries.ts";
import { CenteredScreen } from "../components/centered-screen.tsx";
import { Button } from "../components/ui/button.tsx";
import { FormField } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { shared } from "../components/ui/shared.ts";
import { redirectTarget } from "../lib/redirect.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  lineHeights,
  motion,
  radius,
  shadows,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";

const route = getRouteApi("/manage/login");

const blink = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.25 },
});

// Corner brackets: an L at two opposite corners of the card.
const bracket = {
  borderColor: colors.foreground,
  borderStyle: "solid",
  borderWidth: 0,
  content: '""',
  height: "0.875rem",
  pointerEvents: "none",
  position: "absolute",
  width: "0.875rem",
} as const;

const styles = stylex.create({
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
    justifyContent: "space-between",
    letterSpacing: tracking.wider,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    textTransform: "uppercase",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
    padding: space.xl,
  },
  card: {
    "::after": {
      ...bracket,
      borderBottomWidth: "2px",
      borderRightWidth: "2px",
      bottom: "-0.4375rem",
      right: "-0.4375rem",
    },
    "::before": {
      ...bracket,
      borderLeftWidth: "2px",
      borderTopWidth: "2px",
      left: "-0.4375rem",
      top: "-0.4375rem",
    },
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.md,
    color: colors.cardForeground,
    maxWidth: "26rem",
    position: "relative",
    width: "100%",
  },
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.md,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  env: {
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
  },
  footer: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    display: "flex",
    fontSize: fontSizes.sm,
    justifyContent: "space-between",
    paddingBlock: space.md,
    paddingInline: space.xl,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  link: {
    color: {
      ":hover": colors.foreground,
      default: colors.mutedForeground,
    },
    textDecorationColor: colors.border,
    textUnderlineOffset: "3px",
  },
  signal: {
    alignItems: "center",
    color: colors.mutedForeground,
    display: "flex",
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    gap: space.sm,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
  signalDenied: {
    color: colors.dangerForeground,
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
  submit: {
    transitionDuration: motion.fast,
    width: "100%",
  },
  title: {
    "::before": {
      backgroundColor: "currentColor",
      content: '""',
      flexShrink: 0,
      height: "0.625rem",
      width: "0.625rem",
    },
    alignItems: "center",
    display: "flex",
    fontSize: fontSizes.xxl,
    fontWeight: fontWeights.semibold,
    gap: space.md,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.tight,
    margin: 0,
    textTransform: "uppercase",
  },
});

type Signal = "idle" | "busy" | "denied";

const signalText = {
  busy: "Verifying credentials",
  denied: "Access denied",
  idle: "Awaiting credentials",
} satisfies Record<Signal, string>;

/**
 * Sign in with the API token (`POST /api/session`), then go back to the
 * page that sent us here (`?redirect=`), or to the dashboard.
 */
export const LoginPage = () => {
  const search = route.useSearch();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [empty, setEmpty] = useState(false);
  const signIn = useMutation(signInMutation);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (token.trim() === "") {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    signIn.mutate(token, {
      onSuccess: () =>
        navigate({ href: redirectTarget(search.redirect), replace: true }),
    });
  };

  const { error } = signIn;
  let fieldError: string | undefined;
  if (empty) {
    fieldError = "Enter the API token.";
  } else if (error !== null) {
    fieldError = isUnauthorized(error)
      ? "That token is not valid."
      : describeError(error).message;
  }
  let signal: Signal = "idle";
  if (signIn.isPending || signIn.isSuccess) {
    signal = "busy";
  } else if (error !== null) {
    signal = "denied";
  }

  return (
    <CenteredScreen>
      <section aria-labelledby="login-title" {...stylex.props(styles.card)}>
        <div aria-hidden {...stylex.props(styles.bar)}>
          <span>Authentication</span>
          <span>[ 01 ]</span>
        </div>
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.heading)}>
            <span {...stylex.props(shared.label)}>Kanshi // Command</span>
            <h1 id="login-title" {...stylex.props(styles.title)}>
              Sign in
            </h1>
            <p {...stylex.props(styles.description)}>
              Enter the API token to access the monitors. It is the{" "}
              <code {...stylex.props(styles.env)}>KANSHI_API_TOKEN</code> of
              this deployment.
            </p>
          </div>
          <form noValidate onSubmit={onSubmit} {...stylex.props(styles.form)}>
            <FormField error={fieldError} label="API token" name="token">
              <Input
                autoComplete="current-password"
                disabled={signIn.isPending}
                mono
                onValueChange={(value) => {
                  setToken(value);
                  setEmpty(false);
                }}
                placeholder="••••••••••••"
                type="password"
                value={token}
              />
            </FormField>
            <Button
              disabled={signIn.isPending}
              size="lg"
              style={styles.submit}
              type="submit"
            >
              {signIn.isPending ? "Verifying…" : "Sign in"}
            </Button>
            <p
              aria-live="polite"
              {...stylex.props(
                styles.signal,
                signal === "denied" && styles.signalDenied
              )}
            >
              <span
                aria-hidden
                {...stylex.props(
                  styles.signalDot,
                  signal === "busy" && styles.signalDotBusy
                )}
              />
              {signalText[signal]}
            </p>
          </form>
        </div>
        <div {...stylex.props(styles.footer)}>
          <span {...stylex.props(shared.label)}>Public</span>
          <Link to="/" {...stylex.props(styles.link)}>
            Status page →
          </Link>
        </div>
      </section>
    </CenteredScreen>
  );
};
