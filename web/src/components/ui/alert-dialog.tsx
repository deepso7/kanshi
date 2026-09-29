import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import type { ButtonVariant } from "./button.tsx";
import { Button } from "./button.tsx";
import { dialogStyles as styles } from "./dialog-styles.ts";

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

/**
 * A confirmation that needs an answer (delete, discard): no close on
 * outside click, focus starts inside, `role="alertdialog"`.
 */
export const AlertDialog = BaseAlertDialog.Root;

export const AlertDialogTrigger = BaseAlertDialog.Trigger;

export const AlertDialogContent = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseAlertDialog.Popup>>) => (
  <BaseAlertDialog.Portal>
    <BaseAlertDialog.Backdrop {...stylex.props(styles.backdrop)} />
    <BaseAlertDialog.Popup {...props} {...stylex.props(styles.popup, style)} />
  </BaseAlertDialog.Portal>
);

export const AlertDialogHeader = ({
  style,
  ...props
}: Styled<ComponentProps<"div">>) => (
  <div {...props} {...stylex.props(styles.header, style)} />
);

export const AlertDialogFooter = ({
  style,
  ...props
}: Styled<ComponentProps<"div">>) => (
  <div {...props} {...stylex.props(styles.footer, style)} />
);

export const AlertDialogTitle = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseAlertDialog.Title>>) => (
  <BaseAlertDialog.Title {...props} {...stylex.props(styles.title, style)} />
);

export const AlertDialogDescription = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseAlertDialog.Description>>) => (
  <BaseAlertDialog.Description
    {...props}
    {...stylex.props(styles.description, style)}
  />
);

/** Dismisses the dialog: an outline button. */
export const AlertDialogCancel = ({
  children = "Cancel",
  ...props
}: Omit<
  ComponentProps<typeof BaseAlertDialog.Close>,
  "render" | "className" | "style"
>) => (
  <BaseAlertDialog.Close {...props} render={<Button variant="outline" />}>
    {children}
  </BaseAlertDialog.Close>
);

/**
 * The confirming action. It does not close the dialog by itself: run the
 * action, then close (controlled `open`) when it succeeds, so a failure can
 * be shown in place.
 */
export const AlertDialogAction = ({
  variant = "destructive",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant"> & {
  readonly variant?: ButtonVariant;
}) => <Button variant={variant} {...props} />;
