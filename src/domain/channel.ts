import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { MonitorKey } from "./monitor-input.ts";
import { checkTargetUrl, describeUrlRejection, isLoopback } from "./url.ts";

/**
 * Alert channels are global (owned by the Registry). `webhook` is a generic
 * JSON POST; the others use the service's own payload format.
 */
export const ChannelKind = Schema.Literals([
  "slack",
  "discord",
  "webhook",
  "ntfy",
]);
export type ChannelKind = typeof ChannelKind.Type;

const ChannelName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200)
);
const ChannelUrl = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048)
);

export const ChannelCreateInput = Schema.Struct({
  key: Schema.optionalKey(MonitorKey),
  kind: ChannelKind,
  managed: Schema.optionalKey(Schema.Boolean),
  name: ChannelName,
  url: ChannelUrl,
});
export type ChannelCreateInput = typeof ChannelCreateInput.Type;

/** Any field may change; the URL can be replaced but is never read back. */
export const ChannelPatchInput = Schema.Struct({
  kind: Schema.optionalKey(ChannelKind),
  managed: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(ChannelName),
  url: Schema.optionalKey(ChannelUrl),
});
export type ChannelPatchInput = typeof ChannelPatchInput.Type;

/**
 * A channel as the API shows it. The URL is a write-only secret: only a
 * masked form and its SHA-256 hash (hex, of the normalised URL) leave the
 * Registry, so config sync can diff without reading it.
 */
export const ChannelView = Schema.Struct({
  createdAt: Schema.Number,
  id: Schema.String,
  key: Schema.String,
  kind: ChannelKind,
  managed: Schema.Boolean,
  maskedUrl: Schema.String,
  name: Schema.String,
  updatedAt: Schema.Number,
  urlHash: Schema.String,
});
export type ChannelView = typeof ChannelView.Type;

/** What delivery needs: the channel including its secret URL. */
export interface ChannelTarget {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly name: string;
  readonly url: string;
}

export interface ChannelUrlOptions {
  /** Dev stage: `http://localhost` (loopback) webhooks are allowed. */
  readonly devMode: boolean;
}

/**
 * Validate and normalise a channel URL: the target URL rules (no
 * credentials, no local hostnames or private IP literals), and https only.
 * The dev stage also allows loopback hosts over http, for the `/_dev/webhook`
 * sink. A URL without a scheme gets `https://`.
 */
export const checkChannelUrl = (
  input: string,
  options: ChannelUrlOptions
): Result.Result<string, string> =>
  checkTargetUrl(input, { allowLoopback: options.devMode }).pipe(
    Result.mapError((rejection) => `url: ${describeUrlRejection(rejection)}`),
    Result.flatMap((url) => {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ||
        (options.devMode && isLoopback(parsed.hostname))
        ? Result.succeed(url)
        : Result.fail("url: alert channel URLs must use https");
    })
  );

const visibleTail = 4;
const minHiddenForTail = 12;

/**
 * The origin and, for long enough secrets, the last 4 characters:
 * `https://hooks.slack.com/****abcd`.
 */
export const maskUrl = (url: string): string => {
  if (!URL.canParse(url)) {
    return "****";
  }
  const parsed = new URL(url);
  const rest = url.slice(parsed.origin.length);
  const tail = rest.length >= minHiddenForTail ? rest.slice(-visibleTail) : "";
  return `${parsed.origin}/****${tail}`;
};

/** SHA-256 of the (normalised) URL, lower-case hex. */
export const hashUrl = (url: string): Effect.Effect<string> =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))
  ).pipe(
    Effect.map((digest) =>
      [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
    )
  );
