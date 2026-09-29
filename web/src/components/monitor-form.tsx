// The monitor form, shared by "new" and "edit": every field in four
// sections, client-side validation that mirrors the server's, and the
// server's answer mapped back onto a field. The page owns the mutations
// and the navigation (`onCreate` / `onUpdate` reject with the API error).
import * as stylex from "@stylexjs/stylex";
import type { FormEvent, ReactNode } from "react";
import { useId, useRef, useState } from "react";

import type { MonitorResponse } from "../../../src/api/spec.ts";
import type { ChannelView } from "../../../src/domain/channel.ts";
import type {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../../../src/domain/monitor-input.ts";
import { formatInterval } from "../lib/format.ts";
import {
  colors,
  fontSizes,
  fontWeights,
  fonts,
  layers,
  lineHeights,
  media,
  radius,
  space,
  tracking,
} from "../theme/tokens.stylex.ts";
import { ChoiceCard, ChoiceCards } from "./choice-cards.tsx";
import { ErrorPanel } from "./error-panel.tsx";
import type {
  FieldErrors,
  FormRules,
  MonitorFormField,
  MonitorFormValues,
} from "./monitor-form-model.ts";
import {
  createPayload,
  defaultFormValues,
  formValuesOf,
  hasErrors,
  maxBodyContains,
  maxIntervalSeconds,
  maxThreshold,
  maxTimeoutSeconds,
  minThreshold,
  minTimeoutSeconds,
  normalizedUrl,
  patchPayload,
  patchSize,
  serverFieldError,
  validateMonitorForm,
} from "./monitor-form-model.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Field, FieldDescription, FieldLabel, FormField } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./ui/select.tsx";
import { shared } from "./ui/shared.ts";
import { Switch } from "./ui/switch.tsx";

const styles = stylex.create({
  affix: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    pointerEvents: "none",
    position: "absolute",
    right: space.md,
    top: "50%",
    transform: "translateY(-50%)",
  },
  affixInput: {
    paddingRight: "2.25rem",
  },
  affixWrap: {
    position: "relative",
  },
  channel: {
    alignItems: "center",
    backgroundColor: { ":hover": colors.accent, default: "transparent" },
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    cursor: "pointer",
    display: "flex",
    gap: space.md,
    minWidth: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
  },
  channelMeta: {
    color: colors.mutedForeground,
    fontFamily: fonts.mono,
    fontSize: fontSizes.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  channelName: {
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  channelText: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  channels: {
    display: "grid",
    gap: space.sm,
    gridTemplateColumns: "repeat(auto-fill, minmax(16rem, 1fr))",
  },
  channelsBlock: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  fieldset: {
    borderWidth: 0,
    margin: 0,
    minWidth: 0,
    padding: 0,
  },
  footer: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderTopColor: colors.foreground,
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    bottom: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: space.md,
    justifyContent: "space-between",
    paddingBlock: space.md,
    position: "sticky",
    zIndex: layers.sticky,
  },
  footerActions: {
    display: "flex",
    gap: space.sm,
    marginLeft: "auto",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  grid: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      default: "1fr",
    },
  },
  gridMethod: {
    display: "grid",
    gap: space.lg,
    gridTemplateColumns: {
      "@media (min-width: 640px)": "9rem minmax(0, 1fr)",
      default: "1fr",
    },
  },
  hint: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
    lineHeight: lineHeights.normal,
    margin: 0,
  },
  hintError: {
    color: colors.dangerForeground,
  },
  hintWarning: {
    color: colors.warningForeground,
  },
  legend: {
    marginBottom: space.sm,
    padding: 0,
  },
  mono: {
    fontFamily: fonts.mono,
    overflowWrap: "anywhere",
  },
  presetActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    color: colors.primaryForeground,
  },
  presets: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.xs,
  },
  section: {
    borderTopColor: colors.border,
    borderTopStyle: "solid",
    borderTopWidth: { ":first-of-type": 0, default: "1px" },
    columnGap: space.xxl,
    display: "grid",
    gridTemplateColumns: { default: "1fr", [media.lg]: "15rem 1fr" },
    paddingTop: { ":first-of-type": 0, default: space.xl },
    rowGap: space.lg,
  },
  sectionBody: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    minWidth: 0,
  },
  sectionIndex: {
    fontFamily: fonts.mono,
  },
  sectionIntro: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  sectionTitle: {
    "::before": {
      backgroundColor: "currentColor",
      content: '""',
      flexShrink: 0,
      height: "0.4375rem",
      width: "0.4375rem",
    },
    alignItems: "center",
    display: "flex",
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.semibold,
    gap: space.sm,
    letterSpacing: tracking.wide,
    margin: 0,
    textTransform: "uppercase",
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  status: {
    color: colors.mutedForeground,
    fontSize: fontSizes.sm,
  },
  statusDirty: {
    color: colors.foreground,
    fontWeight: fontWeights.medium,
  },
  toggle: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderStyle: "solid",
    borderWidth: "1px",
    display: "flex",
    flexDirection: "row",
    gap: space.lg,
    justifyContent: "space-between",
    paddingBlock: space.md,
    paddingInline: space.md,
  },
  toggleText: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    minWidth: 0,
  },
});

const intervalPresets = [10, 30, 60, 300, 900, 3600] as const;

const Section = ({
  children,
  description,
  index,
  title,
}: {
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly index: string;
  readonly title: string;
}) => {
  const id = useId();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionIntro)}>
        <span {...stylex.props(shared.label, styles.sectionIndex)}>
          {index}
        </span>
        <h2 id={id} {...stylex.props(styles.sectionTitle)}>
          {title}
        </h2>
        <p {...stylex.props(styles.hint)}>{description}</p>
      </div>
      <div {...stylex.props(styles.sectionBody)}>{children}</div>
    </section>
  );
};

/** A number input with its unit inside, on the right. */
const UnitInput = ({
  onBlur,
  onValueChange,
  unit,
  value,
  ...props
}: {
  readonly value: string;
  readonly unit?: string;
  readonly onValueChange: (value: string) => void;
  readonly onBlur: () => void;
  readonly min: number;
  readonly max: number;
  readonly step?: number | "any";
  readonly disabled?: boolean;
}) => (
  <div {...stylex.props(styles.affixWrap)}>
    <Input
      inputMode="decimal"
      mono
      onBlur={onBlur}
      onValueChange={onValueChange}
      style={unit === undefined ? undefined : styles.affixInput}
      type="number"
      value={value}
      {...props}
    />
    {unit === undefined ? null : (
      <span aria-hidden {...stylex.props(styles.affix)}>
        {unit}
      </span>
    )}
  </div>
);

const ToggleRow = ({
  checked,
  description,
  disabled,
  label,
  name,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly description: ReactNode;
  readonly disabled: boolean;
  readonly label: string;
  readonly name: string;
  readonly onCheckedChange: (checked: boolean) => void;
}) => (
  <Field disabled={disabled} name={name} style={styles.toggle}>
    <div {...stylex.props(styles.toggleText)}>
      <FieldLabel>{label}</FieldLabel>
      <FieldDescription>{description}</FieldDescription>
    </div>
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </Field>
);

const channelKindLabels = {
  discord: "Discord",
  ntfy: "ntfy",
  slack: "Slack",
  webhook: "Webhook",
} satisfies Record<ChannelView["kind"], string>;

/** What each section needs: the values, their errors and the setters. */
interface FormControl {
  readonly values: MonitorFormValues;
  readonly clientErrors: FieldErrors;
  readonly errorFor: (field: MonitorFormField) => string | undefined;
  readonly set: <K extends keyof MonitorFormValues>(
    key: K,
    value: MonitorFormValues[K]
  ) => void;
  readonly touch: (field: MonitorFormField) => () => void;
  readonly pending: boolean;
  readonly rules: FormRules;
}

const urlHint = (values: MonitorFormValues, rules: FormRules): ReactNode => {
  const target = normalizedUrl(values.url, rules.devMode);
  if (target !== null && target !== values.url.trim()) {
    return (
      <>
        Checks <span {...stylex.props(styles.mono)}>{target}</span>
      </>
    );
  }
  return `http or https; without a scheme, https:// is assumed.${rules.devMode ? " Dev mode: localhost is allowed." : ""}`;
};

const TargetSection = ({
  form: { errorFor, rules, set, touch, values },
  isNew,
}: {
  readonly form: FormControl;
  readonly isNew: boolean;
}) => (
  <Section
    description="The URL to request, and what counts as a healthy answer."
    index="01"
    title="Target"
  >
    <FormField
      description="Shown on the dashboard, in alerts and on the status page."
      error={errorFor("name")}
      label="Name"
      name="name"
    >
      <Input
        autoComplete="off"
        onBlur={touch("name")}
        onValueChange={(value) => set("name", value)}
        placeholder="API health"
        value={values.name}
      />
    </FormField>
    <FormField
      description={urlHint(values, rules)}
      error={errorFor("url")}
      label="URL"
      name="url"
    >
      <Input
        autoComplete="off"
        inputMode="url"
        mono
        onBlur={touch("url")}
        onValueChange={(value) => set("url", value)}
        placeholder="https://example.com/health"
        spellCheck={false}
        value={values.url}
      />
    </FormField>
    <div {...stylex.props(styles.gridMethod)}>
      <FormField label="Method" name="method">
        <Select
          items={{ GET: "GET", HEAD: "HEAD" }}
          onValueChange={(value) => {
            if (value === "GET" || value === "HEAD") {
              set("method", value);
            }
          }}
          value={values.method}
        >
          <SelectTrigger />
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="HEAD">HEAD</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      <FormField
        description="A code (200), a class (2xx) or a list (200,204,3xx)."
        error={errorFor("expectedStatus")}
        label="Expected status"
        name="expectedStatus"
      >
        <Input
          autoComplete="off"
          mono
          onBlur={touch("expectedStatus")}
          onValueChange={(value) => set("expectedStatus", value)}
          placeholder="2xx"
          spellCheck={false}
          value={values.expectedStatus}
        />
      </FormField>
    </div>
    <FormField
      description={`Optional. The response body must contain this text (GET only, up to ${maxBodyContains} characters).`}
      error={errorFor("bodyContains")}
      label="Body contains"
      name="bodyContains"
    >
      <Input
        autoComplete="off"
        mono
        onBlur={touch("bodyContains")}
        onValueChange={(value) => set("bodyContains", value)}
        placeholder='"status":"ok"'
        spellCheck={false}
        value={values.bodyContains}
      />
    </FormField>
    {isNew ? (
      <FormField
        description="Optional. A stable identifier for config as code (kanshi.config.ts); the monitor’s id when empty."
        error={errorFor("key")}
        label="Key"
        name="key"
      >
        <Input
          autoComplete="off"
          mono
          onBlur={touch("key")}
          onValueChange={(value) => set("key", value)}
          placeholder="api-health"
          spellCheck={false}
          value={values.key}
        />
      </FormField>
    ) : null}
  </Section>
);

const ScheduleSection = ({
  form: { clientErrors, errorFor, rules, set, touch, values },
}: {
  readonly form: FormControl;
}) => {
  const interval = Number(values.intervalSeconds);
  const intervalHint =
    clientErrors.intervalSeconds === undefined
      ? `Every ${formatInterval(interval)}. `
      : "";
  return (
    <Section
      description="How often to check, and how long to wait for an answer."
      index="02"
      title="Schedule"
    >
      <div {...stylex.props(styles.grid)}>
        <div {...stylex.props(styles.stack)}>
          <FormField
            description={`${intervalHint}At least ${formatInterval(rules.minIntervalSeconds)}, at most 24h.`}
            error={errorFor("intervalSeconds")}
            label="Check interval"
            name="intervalSeconds"
          >
            <UnitInput
              max={maxIntervalSeconds}
              min={rules.minIntervalSeconds}
              onBlur={touch("intervalSeconds")}
              onValueChange={(value) => set("intervalSeconds", value)}
              step={1}
              unit="s"
              value={values.intervalSeconds}
            />
          </FormField>
          <fieldset {...stylex.props(styles.fieldset, styles.presets)}>
            <legend {...stylex.props(shared.srOnly)}>Common intervals</legend>
            {intervalPresets
              .filter((preset) => preset >= rules.minIntervalSeconds)
              .map((preset) => (
                <Button
                  aria-pressed={interval === preset}
                  key={preset}
                  onClick={() => set("intervalSeconds", String(preset))}
                  size="sm"
                  style={interval === preset && styles.presetActive}
                  variant="outline"
                >
                  {formatInterval(preset)}
                </Button>
              ))}
          </fieldset>
        </div>
        <FormField
          description={`How long to wait for the response: ${minTimeoutSeconds} to ${maxTimeoutSeconds} seconds.`}
          error={errorFor("timeoutSeconds")}
          label="Timeout"
          name="timeoutSeconds"
        >
          <UnitInput
            max={maxTimeoutSeconds}
            min={minTimeoutSeconds}
            onBlur={touch("timeoutSeconds")}
            onValueChange={(value) => set("timeoutSeconds", value)}
            step="any"
            unit="s"
            value={values.timeoutSeconds}
          />
        </FormField>
      </div>
    </Section>
  );
};

const ChannelPicker = ({
  channels,
  channelsLink,
  form: { errorFor, set, values },
}: {
  readonly channels: readonly ChannelView[];
  readonly channelsLink: ReactNode;
  readonly form: FormControl;
}) => {
  if (channels.length === 0) {
    return (
      <p {...stylex.props(styles.hint, styles.hintWarning)}>
        There are no channels yet, so this monitor will not alert.{" "}
        {channelsLink}
      </p>
    );
  }
  const selected = new Set(values.channels);
  const none = !channels.some((channel) => selected.has(channel.id));
  const error = errorFor("channels");
  return (
    <>
      <fieldset {...stylex.props(styles.fieldset, styles.channels)}>
        <legend {...stylex.props(shared.srOnly)}>Channels</legend>
        {channels.map((channel) => (
          <label key={channel.id} {...stylex.props(styles.channel)}>
            <Checkbox
              checked={selected.has(channel.id)}
              onCheckedChange={(checked) =>
                set(
                  "channels",
                  checked
                    ? [...values.channels, channel.id]
                    : values.channels.filter((id) => id !== channel.id)
                )
              }
            />
            <span {...stylex.props(styles.channelText)}>
              <span {...stylex.props(styles.channelName)}>{channel.name}</span>
              <span {...stylex.props(styles.channelMeta)}>
                {channel.maskedUrl}
              </span>
            </span>
            <Badge variant="outline">{channelKindLabels[channel.kind]}</Badge>
          </label>
        ))}
      </fieldset>
      {error === undefined ? null : (
        <p role="alert" {...stylex.props(styles.hint, styles.hintError)}>
          {error}
        </p>
      )}
      {none ? (
        <p {...stylex.props(styles.hint, styles.hintWarning)}>
          No channel selected: this monitor will not send alerts.
        </p>
      ) : null}
    </>
  );
};

const AlertingSection = ({
  channels,
  channelsLink,
  form,
}: {
  readonly channels: readonly ChannelView[];
  readonly channelsLink: ReactNode;
  readonly form: FormControl;
}) => {
  const { errorFor, set, touch, values } = form;
  return (
    <Section
      description="When the monitor changes state, and who hears about it."
      index="03"
      title="Alerting"
    >
      <div {...stylex.props(styles.grid)}>
        <FormField
          description="Failed checks in a row before it is down and alerts go out."
          error={errorFor("failureThreshold")}
          label="Down after"
          name="failureThreshold"
        >
          <UnitInput
            max={maxThreshold}
            min={minThreshold}
            onBlur={touch("failureThreshold")}
            onValueChange={(value) => set("failureThreshold", value)}
            step={1}
            value={values.failureThreshold}
          />
        </FormField>
        <FormField
          description="Successful checks in a row before a down monitor is up again."
          error={errorFor("successThreshold")}
          label="Up after"
          name="successThreshold"
        >
          <UnitInput
            max={maxThreshold}
            min={minThreshold}
            onBlur={touch("successThreshold")}
            onValueChange={(value) => set("successThreshold", value)}
            step={1}
            value={values.successThreshold}
          />
        </FormField>
      </div>
      <fieldset {...stylex.props(styles.fieldset, styles.channelsBlock)}>
        <legend {...stylex.props(shared.label, styles.legend)}>
          Alert channels
        </legend>
        <ChoiceCards
          onValueChange={(value) =>
            set("channelMode", value === "some" ? "some" : "all")
          }
          value={values.channelMode}
        >
          <ChoiceCard
            description="Every channel, including ones added later."
            selected={values.channelMode === "all"}
            title="All channels"
            value="all"
          />
          <ChoiceCard
            description="Only the channels picked below."
            selected={values.channelMode === "some"}
            title="Selected channels"
            value="some"
          />
        </ChoiceCards>
        {values.channelMode === "some" ? (
          <ChannelPicker
            channels={channels}
            channelsLink={channelsLink}
            form={form}
          />
        ) : null}
      </fieldset>
    </Section>
  );
};

const VisibilitySection = ({
  form: { pending, set, values },
}: {
  readonly form: FormControl;
}) => (
  <Section
    description="Whether it runs, and whether the public status page lists it."
    index="04"
    title="Visibility"
  >
    <ToggleRow
      checked={values.enabled}
      description="Paused monitors keep their history but are not checked and do not alert."
      disabled={pending}
      label="Checking"
      name="enabled"
      onCheckedChange={(checked) => set("enabled", checked)}
    />
    <ToggleRow
      checked={values.public}
      description="List it on the public status page: its name and uptime, never the URL."
      disabled={pending}
      label="Public"
      name="public"
      onCheckedChange={(checked) => set("public", checked)}
    />
  </Section>
);

const footerStatus = (isNew: boolean, changes: number): string => {
  if (isNew) {
    return "Everything can be changed later.";
  }
  if (changes === 0) {
    return "No changes yet.";
  }
  return `${changes} unsaved ${changes === 1 ? "change" : "changes"}.`;
};

const submitLabel = (isNew: boolean, pending: boolean): string => {
  if (pending) {
    return isNew ? "Creating…" : "Saving…";
  }
  return isNew ? "Create monitor" : "Save changes";
};

export interface MonitorFormProps {
  /** Null: a new monitor. */
  readonly monitor: MonitorResponse | null;
  readonly channels: readonly ChannelView[];
  readonly rules: FormRules;
  /** Resolves when created; rejects with the API error. */
  readonly onCreate: (payload: MonitorCreateInput) => Promise<void>;
  /** Resolves when saved; rejects with the API error. */
  readonly onUpdate: (patch: MonitorPatchInput) => Promise<void>;
  /** The Cancel link (back to the page we came from). */
  readonly cancel: ReactNode;
  /** A link to the channels page, when there is no channel yet. */
  readonly channelsLink: ReactNode;
}

/** Every field of a monitor, grouped: target, schedule, alerting, visibility. */
export const MonitorForm = ({
  cancel,
  channels,
  channelsLink,
  monitor,
  onCreate,
  onUpdate,
  rules,
}: MonitorFormProps) => {
  const isNew = monitor === null;
  // The baseline a patch is computed against: the monitor as the form
  // opened (a background refetch must not turn untouched fields into
  // changes), moved on after a save.
  const [initial, setInitial] = useState<MonitorFormValues>(() =>
    monitor === null ? defaultFormValues : formValuesOf(monitor)
  );
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<ReadonlySet<MonitorFormField>>(
    () => new Set<MonitorFormField>()
  );
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const clientErrors = validateMonitorForm(values, rules);
  const form: FormControl = {
    clientErrors,
    errorFor: (field) =>
      serverErrors[field] ??
      (submitted || touched.has(field) ? clientErrors[field] : undefined),
    pending,
    rules,
    set: (key, value) => {
      setValues((previous) => ({ ...previous, [key]: value }));
      setServerErrors((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([field]) => field !== key)
        )
      );
    },
    touch: (field) => () =>
      setTouched((previous) => new Set(previous).add(field)),
    values,
  };

  const patch = isNew ? null : patchPayload(initial, values, channels);
  const changes = patch === null ? 0 : patchSize(patch);

  const focusFirstInvalid = () => {
    requestAnimationFrame(() => {
      formRef.current
        ?.querySelector<HTMLElement>(
          "[aria-invalid='true'], [data-invalid] input:not([type=hidden])"
        )
        ?.focus();
    });
  };

  const onFailure = (failure: Error) => {
    const mapped = serverFieldError(failure);
    if (mapped !== null && (isNew || mapped.field !== "key")) {
      setServerErrors({ [mapped.field]: mapped.message });
      focusFirstInvalid();
    } else {
      setFormError(failure);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (hasErrors(clientErrors)) {
      focusFirstInvalid();
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      await (patch === null
        ? onCreate(createPayload(values, channels))
        : onUpdate(patch));
      setInitial(values);
    } catch (error: unknown) {
      onFailure(error instanceof Error ? error : new Error(String(error)));
    }
    setPending(false);
  };

  return (
    <form
      aria-busy={pending}
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      ref={formRef}
      {...stylex.props(styles.form)}
    >
      {formError === null ? null : <ErrorPanel error={formError} />}
      <TargetSection form={form} isNew={isNew} />
      <ScheduleSection form={form} />
      <AlertingSection
        channels={channels}
        channelsLink={channelsLink}
        form={form}
      />
      <VisibilitySection form={form} />
      <div {...stylex.props(styles.footer)}>
        <span
          aria-live="polite"
          {...stylex.props(styles.status, changes > 0 && styles.statusDirty)}
        >
          {footerStatus(isNew, changes)}
        </span>
        <div {...stylex.props(styles.footerActions)}>
          {cancel}
          <Button disabled={pending || (!isNew && changes === 0)} type="submit">
            {submitLabel(isNew, pending)}
          </Button>
        </div>
      </div>
    </form>
  );
};
