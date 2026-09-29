import { Toast } from "@base-ui/react/toast";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  colors,
  fontSizes,
  fontWeights,
  layers,
  lineHeights,
  motion,
  radius,
  shadows,
  space,
  tracking,
} from "../../theme/tokens.stylex.ts";
import { Button } from "./button.tsx";
import { CloseIcon } from "./icons.tsx";

/** The app's toast queue; `toast(...)` adds to it from anywhere. */
const toastManager = Toast.createToastManager();

export type ToastType = "default" | "success" | "warning" | "error";

export interface ToastOptions {
  readonly description?: ReactNode;
  /** Milliseconds before it closes; 0 keeps it open. Default 5000. */
  readonly timeout?: number;
}

const add = (type: ToastType, title: ReactNode, options?: ToastOptions) =>
  toastManager.add({
    description: options?.description,
    timeout: options?.timeout,
    title,
    type,
  });

/**
 * Sonner-style calls: `toast("Saved")`, `toast.success(...)`,
 * `toast.error(...)`, `toast.dismiss(id)`. Each returns the toast id.
 * Needs one `<Toaster />` mounted.
 */
export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions) => add("default", title, options),
  {
    dismiss: (id: string) => toastManager.close(id),
    error: (title: ReactNode, options?: ToastOptions) =>
      add("error", title, options),
    success: (title: ReactNode, options?: ToastOptions) =>
      add("success", title, options),
    warning: (title: ReactNode, options?: ToastOptions) =>
      add("warning", title, options),
  }
);

const styles = stylex.create({
  close: {
    height: "1.75rem",
    position: "absolute",
    right: space.xs,
    top: space.xs,
    width: "1.75rem",
  },
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.normal,
    margin: 0,
    marginTop: space.xs,
  },
  root: {
    backgroundColor: colors.popover,
    borderColor: colors.border,
    borderLeftColor: {
      ":is([data-type=error])": colors.danger,
      ":is([data-type=success])": colors.success,
      ":is([data-type=warning])": colors.warning,
      default: colors.foreground,
    },
    borderLeftWidth: "3px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    boxShadow: shadows.lg,
    color: colors.popoverForeground,
    opacity: {
      ":is([data-ending-style])": 0,
      ":is([data-starting-style])": 0,
      default: 1,
    },
    paddingBlock: space.md,
    paddingLeft: space.lg,
    paddingRight: space.xxl,
    position: "relative",
    transform: {
      ":is([data-ending-style])": "translateX(calc(100% + 2rem))",
      ":is([data-starting-style])": "translateY(0.5rem)",
      default:
        "translateX(var(--toast-swipe-movement-x, 0)) translateY(var(--toast-swipe-movement-y, 0))",
    },
    transitionDuration: motion.slow,
    transitionProperty: "opacity, transform",
    transitionTimingFunction: motion.ease,
    userSelect: "none",
  },
  title: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    letterSpacing: tracking.wide,
    lineHeight: lineHeights.tight,
    margin: 0,
    textTransform: "uppercase",
  },
  viewport: {
    bottom: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    maxWidth: "calc(100vw - 2rem)",
    outline: "none",
    position: "fixed",
    right: space.lg,
    width: "22rem",
    zIndex: layers.toast,
  },
});

const ToastList = () => {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport {...stylex.props(styles.viewport)}>
        {toasts.map((item) => (
          <Toast.Root key={item.id} toast={item} {...stylex.props(styles.root)}>
            <Toast.Content>
              <Toast.Title {...stylex.props(styles.title)} />
              <Toast.Description {...stylex.props(styles.description)} />
              <Toast.Close
                aria-label="Dismiss"
                render={
                  <Button size="icon" style={styles.close} variant="ghost" />
                }
              >
                <CloseIcon />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
};

/** Renders the toasts (bottom right); mount once, near the root. */
export const Toaster = () => (
  <Toast.Provider toastManager={toastManager}>
    <ToastList />
  </Toast.Provider>
);
