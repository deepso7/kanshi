// The channel page's dialogs: add, edit and delete. Each form lives inside
// its dialog's popup, so it mounts fresh (empty, no stale errors) every
// time the dialog opens. Validation mirrors the server (`channel-form.ts`);
// what the server still refuses is shown on the field it concerns.
import * as stylex from "@stylexjs/stylex";
import * as Result from "effect/Result";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import type {
  ChannelKind,
  ChannelView,
} from "../../../../src/domain/channel.ts";
import { describeError } from "../../api/errors.ts";
import {
  createChannelMutation,
  deleteChannelMutation,
  updateChannelMutation,
} from "../../api/queries.ts";
import { useToastMutation } from "../../lib/use-toast-mutation.ts";
import {
  colors,
  fontSizes,
  fonts,
  lineHeights,
  radius,
  space,
} from "../../theme/tokens.stylex.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog.tsx";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { FormField } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../ui/select.tsx";
import { shared } from "../ui/shared.ts";
import type { ChannelFieldErrors } from "./channel-form.ts";
import {
  channelKindLabels,
  channelKinds,
  channelUrlHints,
  channelUrlPlaceholders,
  createPayload,
  editPayload,
  maxNameLength,
  serverErrors,
} from "./channel-form.ts";
import { ChannelKindIcon } from "./channel-kind.tsx";

const styles = stylex.create({
  callout: {
    borderLeftWidth: "3px",
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    flexDirection: "column",
    fontSize: fontSizes.sm,
    gap: space.xxs,
    lineHeight: lineHeights.normal,
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  calloutDanger: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    color: colors.dangerForeground,
  },
  calloutWarning: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
    color: colors.warningForeground,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: "0.95em",
  },
  fields: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  kindOption: {
    alignItems: "center",
    display: "inline-flex",
    gap: space.sm,
  },
  kindOptionIcon: {
    color: colors.mutedForeground,
    flexShrink: 0,
  },
  optional: {
    letterSpacing: 0,
    opacity: 0.75,
    textTransform: "none",
  },
  row: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      "@media (min-width: 480px)": "minmax(0, 3fr) minmax(0, 2fr)",
      default: "minmax(0, 1fr)",
    },
  },
  secret: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "dashed",
    borderWidth: "1px",
    display: "flex",
    gap: space.sm,
    minHeight: "2.25rem",
    paddingInline: space.md,
  },
  secretIcon: {
    color: colors.mutedForeground,
    flexShrink: 0,
  },
  secretTag: {
    marginLeft: "auto",
    whiteSpace: "nowrap",
  },
  secretText: {
    color: colors.foreground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.sm,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  wide: {
    width: "34rem",
  },
});

// -- small parts ---------------------------------------------------------------

/** A note inside a dialog: a warning (managed) or a failure. */
const Callout = ({
  children,
  tone,
}: {
  readonly children: ReactNode;
  readonly tone: "warning" | "danger";
}) => (
  <div
    role={tone === "danger" ? "alert" : "note"}
    {...stylex.props(
      styles.callout,
      tone === "danger" ? styles.calloutDanger : styles.calloutWarning
    )}
  >
    {children}
  </div>
);

const Code = ({ children }: { readonly children: ReactNode }) => (
  <code {...stylex.props(styles.code)}>{children}</code>
);

/** Channels created by `kanshi sync` are overwritten by the next one. */
const ManagedNote = ({ action }: { readonly action: "edit" | "delete" }) => (
  <Callout tone="warning">
    <strong {...stylex.props(shared.label, styles.calloutWarning)}>
      Managed by config
    </strong>
    <span>
      {action === "edit" ? (
        <>
          The next <Code>kanshi sync</Code> overwrites edits made here. Change{" "}
          <Code>kanshi.config.ts</Code> instead.
        </>
      ) : (
        <>
          The next <Code>kanshi sync</Code> creates it again. Remove it from{" "}
          <Code>kanshi.config.ts</Code> as well.
        </>
      )}
    </span>
  </Callout>
);

const LockIcon = () => (
  <svg
    aria-hidden
    fill="none"
    focusable="false"
    height="14"
    stroke="currentColor"
    strokeLinecap="square"
    strokeWidth="1.5"
    viewBox="0 0 16 16"
    width="14"
    {...stylex.props(styles.secretIcon)}
  >
    <rect height="6.5" width="10" x="3" y="7" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);

const KindOption = ({ kind }: { readonly kind: ChannelKind }) => (
  <span {...stylex.props(styles.kindOption)}>
    <ChannelKindIcon kind={kind} {...stylex.props(styles.kindOptionIcon)} />
    {channelKindLabels[kind]}
  </span>
);

const kindItems = {
  discord: <KindOption kind="discord" />,
  ntfy: <KindOption kind="ntfy" />,
  slack: <KindOption kind="slack" />,
  webhook: <KindOption kind="webhook" />,
} satisfies Record<ChannelKind, ReactNode>;

const isChannelKind = (value: string | null): value is ChannelKind =>
  channelKinds.some((kind) => kind === value);

const KindSelect = ({
  disabled,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (kind: ChannelKind) => void;
  readonly value: ChannelKind;
}) => (
  <Select
    disabled={disabled}
    items={kindItems}
    onValueChange={(next: string | null) => {
      if (isChannelKind(next)) {
        onChange(next);
      }
    }}
    value={value}
  >
    <SelectTrigger />
    <SelectContent>
      {channelKinds.map((kind) => (
        <SelectItem key={kind} value={kind}>
          <KindOption kind={kind} />
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

/** `Name`, and `(optional)` in a quieter voice. */
const Optional = ({ children }: { readonly children: ReactNode }) => (
  <>
    {children} <span {...stylex.props(styles.optional)}>(optional)</span>
  </>
);

const urlDescription = (kind: ChannelKind, devMode: boolean): ReactNode =>
  devMode ? (
    <>
      {channelUrlHints[kind]} Dev mode: <Code>http://localhost</Code> works too.
    </>
  ) : (
    channelUrlHints[kind]
  );

/** Drops a field's error once it is edited again. */
const clearing =
  (field: keyof ChannelFieldErrors) =>
  (errors: ChannelFieldErrors): ChannelFieldErrors => ({
    ...errors,
    [field]: undefined,
    form: undefined,
  });

// -- add -------------------------------------------------------------------------

export interface AddChannelDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Dev mode allows `http://localhost` URLs. */
  readonly devMode: boolean;
}

const AddChannelForm = ({
  devMode,
  onDone,
}: {
  readonly devMode: boolean;
  readonly onDone: () => void;
}) => {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("slack");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [errors, setErrors] = useState<ChannelFieldErrors>({});
  const create = useToastMutation(createChannelMutation, {
    error: false,
    success: (channel) => `Added ${channel.name}`,
  });
  const busy = create.isPending;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = createPayload({ key, kind, name, url }, { devMode });
    if (Result.isFailure(payload)) {
      setErrors(payload.failure);
      return;
    }
    setErrors({});
    create.mutate(payload.success, {
      onError: (error) => setErrors(serverErrors(error)),
      onSuccess: () => onDone(),
    });
  };

  return (
    <form
      aria-label="Add channel"
      noValidate
      onSubmit={onSubmit}
      {...stylex.props(styles.form)}
    >
      <DialogHeader>
        <DialogTitle>Add channel</DialogTitle>
        <DialogDescription>
          Alerts go to every channel unless a monitor lists its own. The URL is
          a secret: it is stored, never shown again.
        </DialogDescription>
      </DialogHeader>
      {errors.form === undefined ? null : (
        <Callout tone="danger">{errors.form}</Callout>
      )}
      <div {...stylex.props(styles.fields)}>
        <div {...stylex.props(styles.row)}>
          <FormField error={errors.name} label="Name" name="name">
            <Input
              autoComplete="off"
              disabled={busy}
              maxLength={maxNameLength}
              onValueChange={(value) => {
                setName(value);
                setErrors(clearing("name"));
              }}
              placeholder="On-call Slack"
              value={name}
            />
          </FormField>
          <FormField label="Kind" name="kind">
            <KindSelect disabled={busy} onChange={setKind} value={kind} />
          </FormField>
        </div>
        <FormField
          description={urlDescription(kind, devMode)}
          error={errors.url}
          label="URL"
          name="url"
        >
          <Input
            autoComplete="off"
            disabled={busy}
            inputMode="url"
            mono
            onValueChange={(value) => {
              setUrl(value);
              setErrors(clearing("url"));
            }}
            placeholder={channelUrlPlaceholders[kind]}
            spellCheck={false}
            value={url}
          />
        </FormField>
        <FormField
          description="A stable name for kanshi.config.ts; the id when empty."
          error={errors.key}
          label={<Optional>Key</Optional>}
          name="key"
        >
          <Input
            autoComplete="off"
            disabled={busy}
            mono
            onValueChange={(value) => {
              setKey(value);
              setErrors(clearing("key"));
            }}
            placeholder="oncall-slack"
            spellCheck={false}
            value={key}
          />
        </FormField>
      </div>
      <DialogFooter>
        <DialogClose disabled={busy} render={<Button variant="outline" />}>
          Cancel
        </DialogClose>
        <Button disabled={busy} type="submit">
          {busy ? "Adding…" : "Add channel"}
        </Button>
      </DialogFooter>
    </form>
  );
};

/** "Add channel": name, kind, URL and an optional key. */
export const AddChannelDialog = ({
  devMode,
  onOpenChange,
  open,
}: AddChannelDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent style={styles.wide}>
      <AddChannelForm devMode={devMode} onDone={() => onOpenChange(false)} />
    </DialogContent>
  </Dialog>
);

// -- edit ------------------------------------------------------------------------

export interface EditChannelDialogProps {
  /** The channel being edited; `null` closes the dialog. */
  readonly channel: ChannelView | null;
  readonly onClose: () => void;
  readonly devMode: boolean;
}

const EditChannelForm = ({
  channel,
  devMode,
  onDone,
}: {
  readonly channel: ChannelView;
  readonly devMode: boolean;
  readonly onDone: () => void;
}) => {
  const [name, setName] = useState(channel.name);
  const [kind, setKind] = useState<ChannelKind>(channel.kind);
  const [url, setUrl] = useState("");
  const [errors, setErrors] = useState<ChannelFieldErrors>({});
  const update = useToastMutation(updateChannelMutation, {
    error: false,
    success: (saved) => `Saved ${saved.name}`,
  });
  const busy = update.isPending;
  const dirty =
    name.trim() !== channel.name || kind !== channel.kind || url.trim() !== "";

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const patch = editPayload(channel, { kind, name, url }, { devMode });
    if (Result.isFailure(patch)) {
      setErrors(patch.failure);
      return;
    }
    setErrors({});
    if (Object.keys(patch.success).length === 0) {
      onDone();
      return;
    }
    update.mutate(
      { id: channel.id, patch: patch.success },
      {
        onError: (error) => setErrors(serverErrors(error)),
        onSuccess: () => onDone(),
      }
    );
  };

  return (
    <form
      aria-label={`Edit ${channel.name}`}
      noValidate
      onSubmit={onSubmit}
      {...stylex.props(styles.form)}
    >
      <DialogHeader>
        <DialogTitle>Edit channel</DialogTitle>
        <DialogDescription>
          The current URL stays secret. Enter a new one only to replace it.
        </DialogDescription>
      </DialogHeader>
      {channel.managed ? <ManagedNote action="edit" /> : null}
      {errors.form === undefined ? null : (
        <Callout tone="danger">{errors.form}</Callout>
      )}
      <div {...stylex.props(styles.fields)}>
        <div {...stylex.props(styles.row)}>
          <FormField error={errors.name} label="Name" name="name">
            <Input
              autoComplete="off"
              disabled={busy}
              maxLength={maxNameLength}
              onValueChange={(value) => {
                setName(value);
                setErrors(clearing("name"));
              }}
              value={name}
            />
          </FormField>
          <FormField label="Kind" name="kind">
            <KindSelect disabled={busy} onChange={setKind} value={kind} />
          </FormField>
        </div>
        <div {...stylex.props(styles.fields)}>
          <FormField label="Current URL">
            <div {...stylex.props(styles.secret)}>
              <LockIcon />
              <span
                title={channel.maskedUrl}
                {...stylex.props(styles.secretText)}
              >
                {channel.maskedUrl}
              </span>
              <span {...stylex.props(shared.label, styles.secretTag)}>
                Hidden
              </span>
            </div>
          </FormField>
          <FormField
            description={
              kind === channel.kind ? (
                "Leave empty to keep the current URL."
              ) : (
                <>
                  Leave empty to keep the current URL.{" "}
                  {urlDescription(kind, devMode)}
                </>
              )
            }
            error={errors.url}
            label={<Optional>Replace URL</Optional>}
            name="url"
          >
            <Input
              autoComplete="off"
              disabled={busy}
              inputMode="url"
              mono
              onValueChange={(value) => {
                setUrl(value);
                setErrors(clearing("url"));
              }}
              placeholder={channelUrlPlaceholders[kind]}
              spellCheck={false}
              value={url}
            />
          </FormField>
        </div>
      </div>
      <DialogFooter>
        <DialogClose disabled={busy} render={<Button variant="outline" />}>
          Cancel
        </DialogClose>
        <Button disabled={busy || !dirty} type="submit">
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
};

/** Rename a channel, change its kind, or replace its URL. */
export const EditChannelDialog = ({
  channel,
  devMode,
  onClose,
}: EditChannelDialogProps) => {
  // Keep the last channel while the dialog animates closed.
  const [shown, setShown] = useState(channel);
  if (channel !== null && channel !== shown) {
    setShown(channel);
  }
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={channel !== null}
    >
      <DialogContent style={styles.wide}>
        {shown === null ? null : (
          <EditChannelForm
            channel={shown}
            devMode={devMode}
            key={shown.id}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

// -- delete ------------------------------------------------------------------------

export interface DeleteChannelDialogProps {
  /** The channel to delete; `null` closes the dialog. */
  readonly channel: ChannelView | null;
  readonly onClose: () => void;
}

const DeleteChannelBody = ({
  channel,
  onDone,
}: {
  readonly channel: ChannelView;
  readonly onDone: () => void;
}) => {
  const remove = useToastMutation(deleteChannelMutation, {
    error: false,
    success: () => `Deleted ${channel.name}`,
  });
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete channel</AlertDialogTitle>
        <AlertDialogDescription>
          Delete <strong>{channel.name}</strong>? Monitors that list this
          channel will stop alerting through it; monitors that alert every
          channel keep alerting the others. This cannot be undone.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {channel.managed ? <ManagedNote action="delete" /> : null}
      {remove.error === null ? null : (
        <Callout tone="danger">{describeError(remove.error).message}</Callout>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={remove.isPending} />
        <AlertDialogAction
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(channel.id, { onSuccess: () => onDone() })
          }
        >
          {remove.isPending ? "Deleting…" : "Delete channel"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
};

/** Confirm, then delete; a failure stays in the dialog. */
export const DeleteChannelDialog = ({
  channel,
  onClose,
}: DeleteChannelDialogProps) => {
  const [shown, setShown] = useState(channel);
  if (channel !== null && channel !== shown) {
    setShown(channel);
  }
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={channel !== null}
    >
      <AlertDialogContent>
        {shown === null ? null : (
          <DeleteChannelBody channel={shown} key={shown.id} onDone={onClose} />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
};
