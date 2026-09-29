import { Field as BaseField } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";

import {
  colors,
  fontSizes,
  lineHeights,
  space,
} from "../../theme/tokens.stylex.ts";
import { shared } from "./shared.ts";

const styles = stylex.create({
  description: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  error: {
    "::before": {
      backgroundColor: colors.danger,
      content: '""',
      flexShrink: 0,
      height: "0.375rem",
      transform: "translateY(-0.1em)",
      width: "0.375rem",
    },
    alignItems: "baseline",
    color: colors.dangerForeground,
    display: "flex",
    fontSize: fontSizes.sm,
    gap: space.xs,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  label: {
    color: {
      ":is([data-invalid])": colors.dangerForeground,
      default: colors.foreground,
    },
    width: "fit-content",
  },
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
    minWidth: 0,
  },
});

type Styled<T> = Omit<T, "className" | "style"> & {
  readonly style?: stylex.StyleXStyles;
};

/** Groups a label, a control, a description and an error (Base UI Field). */
export const Field = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseField.Root>>) => (
  <BaseField.Root {...props} {...stylex.props(styles.root, style)} />
);

export const FieldLabel = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseField.Label>>) => (
  <BaseField.Label
    {...props}
    {...stylex.props(shared.label, styles.label, style)}
  />
);

export const FieldDescription = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseField.Description>>) => (
  <BaseField.Description
    {...props}
    {...stylex.props(styles.description, style)}
  />
);

/**
 * Shows the field's validation message; `match` picks which (`true` for
 * an error set from outside, e.g. by the server).
 */
export const FieldError = ({
  style,
  ...props
}: Styled<ComponentProps<typeof BaseField.Error>>) => (
  <BaseField.Error {...props} {...stylex.props(styles.error, style)} />
);

export interface FormFieldProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** An error from outside (server, form library); marks the field invalid. */
  readonly error?: string | undefined;
  /** Identifies the field in a form submission. */
  readonly name?: string;
  readonly disabled?: boolean;
  /** The control: `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`. */
  readonly children: ReactNode;
  readonly style?: stylex.StyleXStyles;
}

/**
 * The common case (shadcn's FormItem): label, control, description, then
 * the error. Without `error` it shows the control's own validity message.
 */
export const FormField = ({
  children,
  description,
  disabled,
  error,
  label,
  name,
  style,
}: FormFieldProps) => (
  <Field
    disabled={disabled}
    invalid={error === undefined ? undefined : true}
    name={name}
    style={style}
  >
    <FieldLabel>{label}</FieldLabel>
    {children}
    {description === undefined ? null : (
      <FieldDescription>{description}</FieldDescription>
    )}
    {error === undefined ? (
      <FieldError />
    ) : (
      <FieldError match>{error}</FieldError>
    )}
  </Field>
);
