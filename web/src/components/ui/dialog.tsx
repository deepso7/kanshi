import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";

import { Button } from "./button.tsx";
import { dialogStyles as styles } from "./dialog-styles.ts";
import { CloseIcon } from "./icons.tsx";

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

/** Root (open state). Controlled with `open` / `onOpenChange`, or not. */
export const Dialog = BaseDialog.Root;

/** Opens the dialog; `render={<Button />}` for a styled trigger. */
export const DialogTrigger = BaseDialog.Trigger;

/** Closes the dialog; `render={<Button variant="outline" />}`. */
export const DialogClose = BaseDialog.Close;

export type DialogContentProps = Styled<
  ComponentProps<typeof BaseDialog.Popup>
> & {
  /** The top-right close button. Default: shown. */
  readonly showCloseButton?: boolean;
};

/** The modal panel, with its backdrop, in a portal. */
export const DialogContent = ({
  children,
  showCloseButton = true,
  style,
  ...props
}: DialogContentProps) => (
  <BaseDialog.Portal>
    <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
    <BaseDialog.Popup {...props} {...stylex.props(styles.popup, style)}>
      {children}
      {showCloseButton ? (
        <BaseDialog.Close
          aria-label="Close"
          render={<Button size="icon" style={styles.close} variant="ghost" />}
        >
          <CloseIcon />
        </BaseDialog.Close>
      ) : null}
    </BaseDialog.Popup>
  </BaseDialog.Portal>
);

export const DialogHeader = ({
  style,
  ...props
}: Styled<ComponentProps<"div">>) => (
  <div {...props} {...stylex.props(styles.header, style)} />
);

export const DialogFooter = ({
  style,
  ...props
}: Styled<ComponentProps<"div">>) => (
  <div {...props} {...stylex.props(styles.footer, style)} />
);

export const DialogTitle = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseDialog.Title>>) => (
  <BaseDialog.Title {...props} {...stylex.props(styles.title, style)} />
);

export const DialogDescription = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseDialog.Description>>) => (
  <BaseDialog.Description
    {...props}
    {...stylex.props(styles.description, style)}
  />
);
