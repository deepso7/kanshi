import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ChannelCreateInput, ChannelPatchInput } from "../domain/channel.ts";
import {
  checkMethodBody,
  MonitorCreateInput,
  MonitorPatchInput,
} from "../domain/monitor-input.ts";

/** A decoded `application/x-www-form-urlencoded` body. */
export type FormFields = readonly (readonly [string, string])[];

const first = (form: FormFields, name: string): string =>
  (form.find(([key]) => key === name)?.[1] ?? "").trim();

const all = (form: FormFields, name: string): readonly string[] =>
  form.filter(([key]) => key === name).map(([, value]) => value.trim());

const checked = (form: FormFields, name: string): boolean =>
  form.some(([key]) => key === name);

/** An empty field is left out; anything else must be a number. */
const numberField = (
  form: FormFields,
  name: string,
  scale = 1
): number | string | undefined => {
  const value = first(form, name);
  if (value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * scale) : value;
};

/** `200` as a number, `2xx` or `200,204` as text, empty as the default. */
const expectedStatusField = (form: FormFields): number | string | undefined => {
  const value = first(form, "expectedStatus");
  if (value === "") {
    return undefined;
  }
  return /^\d+$/u.test(value) ? Number(value) : value;
};

/** Form labels for the API field names that appear in schema errors. */
const fieldLabels: Readonly<Record<string, string>> = {
  failureThreshold: "Down after N failures",
  intervalSeconds: "Interval",
  kind: "Kind",
  name: "Name",
  successThreshold: "Up after N successes",
  timeoutMs: "Timeout (ms)",
  url: "URL",
};

/** `Expected number\n  at ["intervalSeconds"]` -> `Interval: expected number`. */
export const schemaMessage = (error: Schema.SchemaError): string =>
  error.message.replaceAll(
    /(?<problem>[^\n]+)\n\s*at \["(?<field>[^"]+)"\]/gu,
    (...args: readonly unknown[]) => {
      const groups = args.at(-1) as { field: string; problem: string };
      const label = fieldLabels[groups.field] ?? groups.field;
      return `${label}: ${groups.problem.trim()}`;
    }
  );

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: Record<string, unknown>
): Result.Result<S["Type"], string> =>
  Schema.decodeUnknownResult(schema)(input).pipe(
    Result.mapError(schemaMessage)
  );

/**
 * The monitor form's fields, shared by create and edit. Timeouts are in
 * seconds in the form, milliseconds in the API.
 */
const monitorFields = (form: FormFields) => {
  const channelMode = first(form, "channelMode");
  return {
    bodyContains: first(form, "bodyContains") || null,
    channels: channelMode === "some" ? all(form, "channel") : "all",
    enabled: checked(form, "enabled"),
    expectedStatus: expectedStatusField(form),
    failureThreshold: numberField(form, "failureThreshold"),
    intervalSeconds: numberField(form, "intervalSeconds"),
    method: first(form, "method") || undefined,
    name: first(form, "name"),
    public: checked(form, "public"),
    successThreshold: numberField(form, "successThreshold"),
    timeoutMs: numberField(form, "timeoutSeconds", 1000),
    url: first(form, "url"),
  };
};

const withoutUndefined = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );

/** The form takes seconds; say so rather than the API's millisecond bounds. */
const checkTimeout = (form: FormFields): Result.Result<void, string> => {
  const seconds = Number(first(form, "timeoutSeconds") || "10");
  return seconds >= 1 && seconds <= 30
    ? Result.void
    : Result.fail("Timeout: must be between 1 and 30 seconds");
};

/**
 * The form holds every field, so its method and keyword are the final
 * ones; say it with the form's labels (the service checks it again).
 */
const checkFormMethodBody = (form: FormFields): Result.Result<void, string> =>
  checkMethodBody(
    first(form, "method") === "HEAD" ? "HEAD" : "GET",
    first(form, "bodyContains") || null
  ).pipe(
    Result.mapError(
      () => "Body contains: only works with GET (a HEAD response has no body)"
    )
  );

const checkMonitorForm = (form: FormFields): Result.Result<void, string> =>
  checkTimeout(form).pipe(Result.flatMap(() => checkFormMethodBody(form)));

/** The new-monitor form as API input. */
export const monitorCreateFromForm = (
  form: FormFields
): Result.Result<MonitorCreateInput, string> =>
  checkMonitorForm(form).pipe(
    Result.flatMap(() =>
      decode(
        MonitorCreateInput,
        withoutUndefined({
          ...monitorFields(form),
          key: first(form, "key") || undefined,
        })
      )
    )
  );

/** The edit form as a patch: every field in the form is set. */
export const monitorPatchFromForm = (
  form: FormFields
): Result.Result<MonitorPatchInput, string> =>
  checkMonitorForm(form).pipe(
    Result.flatMap(() =>
      decode(MonitorPatchInput, withoutUndefined(monitorFields(form)))
    )
  );

/** The new-channel form as API input. */
export const channelCreateFromForm = (
  form: FormFields
): Result.Result<ChannelCreateInput, string> =>
  decode(
    ChannelCreateInput,
    withoutUndefined({
      key: first(form, "key") || undefined,
      kind: first(form, "kind"),
      name: first(form, "name"),
      url: first(form, "url"),
    })
  );

/** The channel edit form: an empty URL keeps the stored one. */
export const channelPatchFromForm = (
  form: FormFields
): Result.Result<ChannelPatchInput, string> =>
  decode(
    ChannelPatchInput,
    withoutUndefined({
      kind: first(form, "kind"),
      name: first(form, "name"),
      url: first(form, "url") || undefined,
    })
  );
