// The monitor form's rules, without React: its values (strings, as typed),
// the client-side validation that mirrors the server's
// (`src/domain/monitor-input.ts`, `url.ts`, `expected-status.ts`), the
// payloads it submits (a full create, or a patch of the changed fields) and
// the mapping of a server error back onto a field.
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import type { MonitorResponse } from "../../../src/api/spec.ts";
import type { ChannelView } from "../../../src/domain/channel.ts";
import { parseExpectedStatus } from "../../../src/domain/expected-status.ts";
import type {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../../../src/domain/monitor-input.ts";
import {
  maxIntervalSeconds,
  monitorDefaults,
} from "../../../src/domain/monitor-input.ts";
import type { MonitorMethod } from "../../../src/domain/monitor.ts";
import type { UrlRejection } from "../../../src/domain/url.ts";
import { checkTargetUrl } from "../../../src/domain/url.ts";

/** What the form holds: numbers as typed, the timeout in seconds. */
export interface MonitorFormValues {
  readonly name: string;
  readonly url: string;
  readonly method: MonitorMethod;
  readonly expectedStatus: string;
  readonly bodyContains: string;
  readonly timeoutSeconds: string;
  readonly intervalSeconds: string;
  readonly failureThreshold: string;
  readonly successThreshold: string;
  readonly enabled: boolean;
  readonly public: boolean;
  readonly channelMode: "all" | "some";
  /** Channel ids, when `channelMode` is `some`. */
  readonly channels: readonly string[];
}

/** The fields that can carry an error. */
export type MonitorFormField =
  | "name"
  | "url"
  | "expectedStatus"
  | "bodyContains"
  | "timeoutSeconds"
  | "intervalSeconds"
  | "failureThreshold"
  | "successThreshold"
  | "channels";

export type FieldErrors = Partial<Record<MonitorFormField, string>>;

/** What validation needs to know about the deployment. */
export interface FormRules {
  /** Dev mode: loopback targets are allowed. */
  readonly devMode: boolean;
  /** `GET /api/meta`'s smallest interval. */
  readonly minIntervalSeconds: number;
}

export const minTimeoutSeconds = 1;
export const maxTimeoutSeconds = 30;
export const minThreshold = 1;
export const maxThreshold = 10;
export const maxBodyContains = 1024;
export { maxIntervalSeconds } from "../../../src/domain/monitor-input.ts";

/** A new monitor: the server's defaults (`monitorDefaults`). */
export const defaultFormValues: MonitorFormValues = {
  bodyContains: "",
  channelMode: "all",
  channels: [],
  enabled: monitorDefaults.enabled,
  expectedStatus: monitorDefaults.expectedStatus,
  failureThreshold: String(monitorDefaults.failureThreshold),
  intervalSeconds: String(monitorDefaults.intervalSeconds),
  method: monitorDefaults.method,
  name: "",
  public: monitorDefaults.public,
  successThreshold: String(monitorDefaults.successThreshold),
  timeoutSeconds: String(monitorDefaults.timeoutMs / 1000),
  url: "",
};

/** An existing monitor's values, to edit. */
export const formValuesOf = (monitor: MonitorResponse): MonitorFormValues => ({
  bodyContains: monitor.bodyContains ?? "",
  channelMode: monitor.channels === "all" ? "all" : "some",
  channels: monitor.channels === "all" ? [] : monitor.channels,
  enabled: monitor.enabled,
  expectedStatus: monitor.expectedStatus,
  failureThreshold: String(monitor.failureThreshold),
  intervalSeconds: String(monitor.intervalSeconds),
  method: monitor.method,
  name: monitor.name,
  public: monitor.public,
  successThreshold: String(monitor.successThreshold),
  timeoutSeconds: String(monitor.timeoutMs / 1000),
  url: monitor.url,
});

// -- validation ----------------------------------------------------------------

const wholeNumber = /^\d+$/u;

const urlMessages = {
  blocked_hostname:
    "Local hostnames are not allowed (localhost, *.local, *.internal, or a name without a dot).",
  credentials_not_allowed: "Remove the username and password from the URL.",
  invalid_url: "This is not a valid URL.",
  private_address: "Private and reserved IP addresses are not allowed.",
  protocol_not_allowed: "Only http and https URLs can be checked.",
} satisfies Record<UrlRejection, string>;

/** The URL the server will store (https added without a scheme), or null. */
export const normalizedUrl = (url: string, devMode: boolean): string | null =>
  Result.getOrNull(checkTargetUrl(url, { allowLoopback: devMode }));

const checkUrl = (url: string, devMode: boolean): string | undefined => {
  if (url.trim() === "") {
    return "Enter the URL to check.";
  }
  const checked = checkTargetUrl(url, { allowLoopback: devMode });
  return Result.isFailure(checked) ? urlMessages[checked.failure] : undefined;
};

/** A whole number within bounds. */
const checkWhole = (
  value: string,
  minimum: number,
  maximum: number,
  unit: string
): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "Enter a number.";
  }
  if (!wholeNumber.test(trimmed)) {
    return "Use a whole number.";
  }
  const parsed = Number(trimmed);
  if (parsed < minimum) {
    return `At least ${minimum}${unit}.`;
  }
  return parsed > maximum ? `At most ${maximum}${unit}.` : undefined;
};

const checkTimeout = (value: string): string | undefined => {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed === "") {
    return "Enter a timeout.";
  }
  if (!Number.isFinite(parsed)) {
    return "Enter a number of seconds.";
  }
  return parsed < minTimeoutSeconds || parsed > maxTimeoutSeconds
    ? `Between ${minTimeoutSeconds} and ${maxTimeoutSeconds} seconds.`
    : undefined;
};

const checkExpectedStatus = (value: string): string | undefined => {
  if (value.trim() === "") {
    return "Enter a status code or class, e.g. 2xx.";
  }
  return Result.isFailure(parseExpectedStatus(value))
    ? "Use codes like 200 or classes like 2xx, separated by commas."
    : undefined;
};

const checkBody = (method: MonitorMethod, body: string): string | undefined => {
  if (body.length > maxBodyContains) {
    return `At most ${maxBodyContains} characters.`;
  }
  return method === "HEAD" && body.trim() !== ""
    ? "Only works with GET: a HEAD response has no body. Clear it or switch to GET."
    : undefined;
};

/**
 * Every field's problem, as the server would report it (the server checks
 * again; `serverFieldError` maps its answer back).
 */
export const validateMonitorForm = (
  values: MonitorFormValues,
  rules: FormRules
): FieldErrors => {
  const errors: FieldErrors = {
    bodyContains: checkBody(values.method, values.bodyContains),
    expectedStatus: checkExpectedStatus(values.expectedStatus),
    failureThreshold: checkWhole(
      values.failureThreshold,
      minThreshold,
      maxThreshold,
      ""
    ),
    intervalSeconds: checkWhole(
      values.intervalSeconds,
      rules.minIntervalSeconds,
      maxIntervalSeconds,
      " seconds"
    ),
    name: values.name.trim() === "" ? "Enter a name." : undefined,
    successThreshold: checkWhole(
      values.successThreshold,
      minThreshold,
      maxThreshold,
      ""
    ),
    timeoutSeconds: checkTimeout(values.timeoutSeconds),
    url: checkUrl(values.url, rules.devMode),
  };
  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => message !== undefined)
  );
};

export const hasErrors = (errors: FieldErrors): boolean =>
  Object.values(errors).some((message) => message !== undefined);

// -- payloads ------------------------------------------------------------------

/** The selection as sent: known channel ids only, in the list's order. */
const channelSelection = (
  values: MonitorFormValues,
  channels: readonly ChannelView[]
): "all" | readonly string[] => {
  if (values.channelMode === "all") {
    return "all";
  }
  const selected = new Set(values.channels);
  return channels
    .filter((channel) => selected.has(channel.id))
    .map((channel) => channel.id);
};

/** Every editable field, from valid values. */
const editablePayload = (
  values: MonitorFormValues,
  channels: readonly ChannelView[]
) => {
  const body = values.bodyContains.trim();
  return {
    bodyContains: body === "" ? null : body,
    channels: channelSelection(values, channels),
    enabled: values.enabled,
    expectedStatus: values.expectedStatus.trim().toLowerCase(),
    failureThreshold: Number(values.failureThreshold),
    intervalSeconds: Number(values.intervalSeconds),
    method: values.method,
    name: values.name.trim(),
    public: values.public,
    successThreshold: Number(values.successThreshold),
    timeoutMs: Math.round(Number(values.timeoutSeconds) * 1000),
    url: values.url.trim(),
  } satisfies MonitorPatchInput;
};

/** `POST /api/monitors`: every field. */
export const createPayload = (
  values: MonitorFormValues,
  channels: readonly ChannelView[]
): MonitorCreateInput => editablePayload(values, channels);

const sameChannels = (
  left: "all" | readonly string[],
  right: "all" | readonly string[]
): boolean =>
  left === "all" || right === "all"
    ? left === right
    : left.length === right.length &&
      [...left].toSorted().join("\n") === [...right].toSorted().join("\n");

type MutablePatch = {
  -readonly [K in keyof MonitorPatchInput]: MonitorPatchInput[K];
};

/**
 * `PATCH /api/monitors/:id`: only what changed from `initial` (compared as
 * payloads, so retyping the same value sends nothing).
 */
export const patchPayload = (
  initial: MonitorFormValues,
  values: MonitorFormValues,
  channels: readonly ChannelView[]
): MonitorPatchInput => {
  const before = editablePayload(initial, channels);
  const after = editablePayload(values, channels);
  const patch: MutablePatch = {};
  if (after.name !== before.name) {
    patch.name = after.name;
  }
  if (after.url !== before.url) {
    patch.url = after.url;
  }
  if (after.method !== before.method) {
    patch.method = after.method;
  }
  if (after.expectedStatus !== before.expectedStatus) {
    patch.expectedStatus = after.expectedStatus;
  }
  if (after.bodyContains !== before.bodyContains) {
    patch.bodyContains = after.bodyContains;
  }
  if (after.timeoutMs !== before.timeoutMs) {
    patch.timeoutMs = after.timeoutMs;
  }
  if (after.intervalSeconds !== before.intervalSeconds) {
    patch.intervalSeconds = after.intervalSeconds;
  }
  if (after.failureThreshold !== before.failureThreshold) {
    patch.failureThreshold = after.failureThreshold;
  }
  if (after.successThreshold !== before.successThreshold) {
    patch.successThreshold = after.successThreshold;
  }
  if (after.enabled !== before.enabled) {
    patch.enabled = after.enabled;
  }
  if (after.public !== before.public) {
    patch.public = after.public;
  }
  if (!sameChannels(after.channels, before.channels)) {
    patch.channels = after.channels;
  }
  return patch;
};

/** The number of changed fields in a patch. */
export const patchSize = (patch: MonitorPatchInput): number =>
  Object.keys(patch).length;

// -- server errors -------------------------------------------------------------

export interface ServerFieldError {
  readonly field: MonitorFormField;
  readonly message: string;
}

/** API field names (schema errors say `at ["timeoutMs"]`) to form fields. */
const apiFields = new Map<string, MonitorFormField>([
  ["bodyContains", "bodyContains"],
  ["channels", "channels"],
  ["expectedStatus", "expectedStatus"],
  ["failureThreshold", "failureThreshold"],
  ["intervalSeconds", "intervalSeconds"],
  ["name", "name"],
  ["successThreshold", "successThreshold"],
  ["timeoutMs", "timeoutSeconds"],
  ["url", "url"],
]);

const sentence = (text: string): string => {
  const trimmed = text.trim();
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return capital.endsWith(".") ? capital : `${capital}.`;
};

/** `<field>: <problem>`, as `buildConfig` / `patchConfig` word it. */
const prefixed = /^(?<field>[A-Za-z]+): (?<problem>.+)$/su;
const intervalFloor = /^intervalSeconds must be at least (?<minimum>\d+)/u;
const schemaPath = /at \["(?<field>[A-Za-z]+)"\]/u;

/**
 * A 400 the server gave for one field, reworded for the form; null for
 * anything else (shown above the form).
 */
export const serverFieldError = (error: Error): ServerFieldError | null => {
  if (!Predicate.isTagged(error, "BadRequest")) {
    return null;
  }
  const { message } = error;
  const floor = intervalFloor.exec(message)?.groups;
  if (floor?.minimum !== undefined) {
    return {
      field: "intervalSeconds",
      message: `At least ${floor.minimum} seconds.`,
    };
  }
  const own = prefixed.exec(message)?.groups;
  const ownField = apiFields.get(own?.field ?? "");
  if (own?.problem !== undefined && ownField !== undefined) {
    return { field: ownField, message: sentence(own.problem) };
  }
  const path = apiFields.get(schemaPath.exec(message)?.groups?.field ?? "");
  if (path !== undefined) {
    return {
      field: path,
      message: sentence(message.split("\n")[0] ?? message),
    };
  }
  return null;
};
