// The channel forms' rules, kept pure for tests: what each kind expects,
// client-side validation (the server's own URL rules, `checkChannelUrl`,
// so a URL the form accepts is one the API accepts), the payloads the
// dialogs send, and where a server error belongs.
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type { Mutable } from "effect/Types";

import type {
  ChannelCreateInput,
  ChannelKind,
  ChannelPatchInput,
  ChannelView,
} from "../../../../src/domain/channel.ts";
import { checkChannelUrl } from "../../../../src/domain/channel.ts";
import { describeError } from "../../api/errors.ts";

/** Every kind, in the order the forms list them. */
export const channelKinds: readonly ChannelKind[] = [
  "slack",
  "discord",
  "webhook",
  "ntfy",
];

export const channelKindLabels = {
  discord: "Discord",
  ntfy: "ntfy",
  slack: "Slack",
  webhook: "Webhook",
} satisfies Record<ChannelKind, string>;

/** An example URL per kind (the URL field's placeholder). */
export const channelUrlPlaceholders = {
  discord: "https://discord.com/api/webhooks/…",
  ntfy: "https://ntfy.sh/your-topic",
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://example.com/hooks/kanshi",
} satisfies Record<ChannelKind, string>;

/** What the URL is, per kind (the URL field's description). */
export const channelUrlHints = {
  discord: "A Discord incoming webhook (Server settings, Integrations).",
  ntfy: "An ntfy topic URL; anyone who knows it can read the alerts.",
  slack: "A Slack incoming webhook URL.",
  webhook: "Kanshi POSTs a JSON body to this URL.",
} satisfies Record<ChannelKind, string>;

export const maxNameLength = 200;

/** A field's problem, or none; `form` is not tied to one field. */
export interface ChannelFieldErrors {
  name?: string;
  url?: string;
  form?: string;
}

export const hasErrors = (errors: ChannelFieldErrors): boolean =>
  Object.values(errors).some((message) => message !== undefined);

export interface ChannelFormOptions {
  /** Dev mode (`GET /api/meta`): `http://localhost` is allowed. */
  readonly devMode: boolean;
}

const nameProblem = (name: string): string | undefined => {
  if (name === "") {
    return "Enter a name.";
  }
  if (name.length > maxNameLength) {
    return `At most ${maxNameLength} characters.`;
  }
  return undefined;
};

/** `url: local hostnames are not allowed` -> `Local hostnames are not allowed.` */
const sentence = (message: string): string => {
  const text = message.replace(/^url:\s*/u, "").trim();
  if (text === "") {
    return "This URL is not valid.";
  }
  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
};

/** Why the server would refuse this channel URL, as a sentence. */
export const urlProblem = (
  url: string,
  options: ChannelFormOptions
): string | undefined => {
  if (url === "") {
    return "Enter the URL alerts are sent to.";
  }
  const checked = checkChannelUrl(url, options);
  if (Result.isSuccess(checked)) {
    return undefined;
  }
  if (checked.failure.endsWith("must use https")) {
    return options.devMode
      ? "Use https (or http://localhost in dev mode)."
      : "Alert channel URLs must use https.";
  }
  return sentence(checked.failure);
};

/** What the add form holds (raw input). */
export interface ChannelCreateValues {
  readonly name: string;
  readonly kind: ChannelKind;
  readonly url: string;
}

/** Validate the add form: the payload for `POST /api/channels`, or errors. */
export const createPayload = (
  values: ChannelCreateValues,
  options: ChannelFormOptions
): Result.Result<ChannelCreateInput, ChannelFieldErrors> => {
  const name = values.name.trim();
  const url = values.url.trim();
  const errors: ChannelFieldErrors = {
    name: nameProblem(name),
    url: urlProblem(url, options),
  };
  if (hasErrors(errors)) {
    return Result.fail(errors);
  }
  return Result.succeed({ kind: values.kind, name, url });
};

/** What the edit form holds; an empty `url` keeps the current one. */
export interface ChannelEditValues {
  readonly name: string;
  readonly kind: ChannelKind;
  readonly url: string;
}

/**
 * Validate the edit form: a patch of what changed (maybe empty: nothing
 * to save), or errors. A new URL replaces the secret.
 */
export const editPayload = (
  channel: ChannelView,
  values: ChannelEditValues,
  options: ChannelFormOptions
): Result.Result<ChannelPatchInput, ChannelFieldErrors> => {
  const name = values.name.trim();
  const url = values.url.trim();
  const errors: ChannelFieldErrors = {
    name: nameProblem(name),
    url: url === "" ? undefined : urlProblem(url, options),
  };
  if (hasErrors(errors)) {
    return Result.fail(errors);
  }
  const patch: Mutable<ChannelPatchInput> = {};
  if (name !== channel.name) {
    patch.name = name;
  }
  if (values.kind !== channel.kind) {
    patch.kind = values.kind;
  }
  if (url !== "") {
    patch.url = url;
  }
  return Result.succeed(patch);
};

/**
 * Where a failed create or update belongs: the server's URL check (a 400
 * `url: ...`) on the URL field, anything else above the form.
 */
export const serverErrors = (error: Error): ChannelFieldErrors => {
  if (
    Predicate.isTagged(error, "BadRequest") &&
    error.message.startsWith("url:")
  ) {
    return { url: sentence(error.message) };
  }
  return { form: describeError(error).message };
};

/** A test alert's outcome (`POST /api/channels/:id/test`), for display. */
export interface TestOutcome {
  readonly delivered: boolean;
  readonly title: string;
  readonly detail: string;
}

export const describeTestResult = (result: {
  readonly delivered: boolean;
  readonly status: number | null;
  readonly error: string | null;
}): TestOutcome => {
  const status = result.status === null ? null : `HTTP ${result.status}`;
  if (result.delivered) {
    return {
      delivered: true,
      detail:
        status === null ? "The channel accepted it." : `Accepted, ${status}.`,
      title: "Test alert delivered",
    };
  }
  const reason = result.error ?? "The channel did not accept it.";
  // Delivery errors often start with the status already (`HTTP 500: ...`).
  return {
    delivered: false,
    detail:
      status === null || reason.startsWith(status)
        ? reason
        : `${status}: ${reason}`,
    title: "Test alert failed",
  };
};
