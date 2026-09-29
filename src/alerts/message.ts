import * as Data from "effect/Data";
import * as Match from "effect/Match";

import type { ChannelKind } from "../domain/channel.ts";

export interface AlertMonitor {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface AlertIncident {
  readonly cause: string;
  readonly id: string;
  readonly lastHttpStatus: number | null;
  readonly resolvedAt: number | null;
  readonly startedAt: number;
}

/** A watchdog "not being checked" episode. */
export interface AlertEpisode {
  readonly id: string;
  readonly intervalSeconds: number;
  /** The monitor's last check when the episode opened. */
  readonly lastCheckedAt: number | null;
  readonly resolvedAt: number | null;
  readonly startedAt: number;
}

/** The fields of an alert about a monitor's incident. */
export interface IncidentAlert {
  readonly idempotencyKey: string;
  readonly incident: AlertIncident;
  readonly monitor: AlertMonitor;
  readonly sentAt: number;
}

/** The fields of an alert about a watchdog episode. */
export interface EpisodeAlert {
  readonly episode: AlertEpisode;
  readonly idempotencyKey: string;
  readonly monitor: AlertMonitor;
  readonly sentAt: number;
}

/** The fields of a channel's test alert. */
export interface TestAlert {
  readonly channelName: string;
  readonly idempotencyKey: string;
  readonly sentAt: number;
}

export type IncidentMessageTag = "Down" | "DownRecovered" | "Recovered";

export type WatchdogMessageTag =
  | "CheckedAgain"
  | "NotChecked"
  | "NotCheckedResolved";

/**
 * What a channel is told. `DownRecovered` is a `down` alert sent after the
 * incident already recovered ("was down for Xm, recovered"); the separate
 * recovery alert is then skipped. The watchdog's `NotChecked`,
 * `NotCheckedResolved` and `CheckedAgain` mirror `Down`, `DownRecovered`
 * and `Recovered` for a monitor that is not being checked at all.
 */
export type AlertMessage = Data.TaggedEnum<{
  CheckedAgain: EpisodeAlert;
  Down: IncidentAlert;
  DownRecovered: IncidentAlert;
  NotChecked: EpisodeAlert;
  NotCheckedResolved: EpisodeAlert;
  Recovered: IncidentAlert;
  Test: TestAlert;
}>;

/** Constructors per variant (`AlertMessage.Down`, ...), `$is` and `$match`. */
export const AlertMessage = Data.taggedEnum<AlertMessage>();

/** An incident alert whose variant is only known at runtime. */
export const incidentMessage = (
  tag: IncidentMessageTag,
  alert: IncidentAlert
): AlertMessage => AlertMessage[tag](alert);

/** A watchdog alert whose variant is only known at runtime. */
export const watchdogMessage = (
  tag: WatchdogMessageTag,
  alert: EpisodeAlert
): AlertMessage => AlertMessage[tag](alert);

/** The outbox id of an alert, also its `Idempotency-Key`. */
export const idempotencyKey = (
  incidentId: string,
  event: "down" | "up",
  channelId: string
): string => `${incidentId}:${event}:${channelId}`;

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

/** `45s`, `12m`, `3h 5m`, `2d 4h`. */
export const formatDuration = (ms: number): string => {
  const clamped = Math.max(0, ms);
  if (clamped < minuteMs) {
    return `${Math.floor(clamped / secondMs)}s`;
  }
  if (clamped < hourMs) {
    return `${Math.floor(clamped / minuteMs)}m`;
  }
  if (clamped < dayMs) {
    const minutes = Math.floor((clamped % hourMs) / minuteMs);
    return `${Math.floor(clamped / hourMs)}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  }
  const hours = Math.floor((clamped % dayMs) / hourMs);
  return `${Math.floor(clamped / dayMs)}d${hours > 0 ? ` ${hours}h` : ""}`;
};

const outageMs = (incident: AlertIncident, now: number): number =>
  (incident.resolvedAt ?? now) - incident.startedAt;

/** From the last check before the episode to its end (or `now`). */
const uncheckedMs = (episode: AlertEpisode, now: number): number =>
  (episode.resolvedAt ?? now) - (episode.lastCheckedAt ?? episode.startedAt);

export interface AlertText {
  /** One line: what happened. */
  readonly title: string;
  /** Details: cause, duration, target. */
  readonly body: string;
}

/** The human-readable alert, shared by every channel kind. */
export const alertText = (message: AlertMessage): AlertText =>
  AlertMessage.$match(message, {
    CheckedAgain: (alert) => {
      const duration = formatDuration(uncheckedMs(alert.episode, alert.sentAt));
      return {
        body: alert.monitor.url,
        title: `monitor ${alert.monitor.name} is being checked again after ${duration}`,
      };
    },
    Down: (alert) => ({
      body: `${alert.incident.cause}\n${alert.monitor.url}`,
      title: `${alert.monitor.name} is down`,
    }),
    DownRecovered: (alert) => {
      const duration = formatDuration(outageMs(alert.incident, alert.sentAt));
      return {
        body: `Cause: ${alert.incident.cause}\n${alert.monitor.url}`,
        title: `${alert.monitor.name} was down for ${duration}, recovered`,
      };
    },
    NotChecked: (alert) => {
      const last =
        alert.episode.lastCheckedAt === null
          ? "never"
          : `${formatDuration(alert.sentAt - alert.episode.lastCheckedAt)} ago`;
      const every = formatDuration(alert.episode.intervalSeconds * 1000);
      return {
        body: `Last check: ${last} (expected every ${every})\n${alert.monitor.url}`,
        title: `monitor ${alert.monitor.name} is not being checked`,
      };
    },
    NotCheckedResolved: (alert) => {
      const duration = formatDuration(uncheckedMs(alert.episode, alert.sentAt));
      return {
        body: alert.monitor.url,
        title: `monitor ${alert.monitor.name} was not checked for ${duration}, checks resumed`,
      };
    },
    Recovered: (alert) => {
      const duration = formatDuration(outageMs(alert.incident, alert.sentAt));
      return {
        body: alert.monitor.url,
        title: `${alert.monitor.name} is up again after ${duration}`,
      };
    },
    Test: (alert) => ({
      body: "If you can read this, alerts reach this channel.",
      title: `Test alert for channel "${alert.channelName}"`,
    }),
  });

const plainText = (message: AlertMessage): string => {
  const text = alertText(message);
  return `Kanshi: ${text.title}\n${text.body}`;
};

const episodePayload = (
  alert: EpisodeAlert,
  text: AlertText,
  checked: boolean
) => ({
  episode: {
    ...alert.episode,
    durationMs: uncheckedMs(alert.episode, alert.sentAt),
  },
  event: checked ? "checked" : "not_checked",
  id: alert.idempotencyKey,
  incident: null,
  monitor: alert.monitor,
  recovered: checked,
  sentAt: alert.sentAt,
  text: `${text.title}\n${text.body}`,
  title: text.title,
});

const incidentPayload = (
  alert: IncidentAlert,
  text: AlertText,
  event: "down" | "up",
  recovered: boolean
) => ({
  event,
  id: alert.idempotencyKey,
  incident: {
    ...alert.incident,
    durationMs: outageMs(alert.incident, alert.sentAt),
  },
  monitor: alert.monitor,
  recovered,
  sentAt: alert.sentAt,
  text: `${text.title}\n${text.body}`,
  title: text.title,
});

/** The generic webhook JSON body. */
export const webhookPayload = (message: AlertMessage) => {
  const text = alertText(message);
  return AlertMessage.$match(message, {
    CheckedAgain: (alert) => episodePayload(alert, text, true),
    Down: (alert) => incidentPayload(alert, text, "down", false),
    DownRecovered: (alert) => incidentPayload(alert, text, "down", true),
    NotChecked: (alert) => episodePayload(alert, text, false),
    NotCheckedResolved: (alert) => episodePayload(alert, text, true),
    Recovered: (alert) => incidentPayload(alert, text, "up", true),
    Test: (alert) => ({
      event: "test",
      id: alert.idempotencyKey,
      incident: null,
      monitor: null,
      recovered: false,
      sentAt: alert.sentAt,
      text: `${text.title}\n${text.body}`,
      title: text.title,
    }),
  });
};

export type WebhookPayload = ReturnType<typeof webhookPayload>;

/** Discord rejects message content over 2000 characters. */
const discordMaxLength = 2000;

const ntfyPriority = (message: AlertMessage): string =>
  Match.value(message).pipe(
    Match.tag("Down", "NotChecked", () => "high"),
    Match.tag("Test", () => "low"),
    Match.orElse(() => "default")
  );

const ntfyTags = (message: AlertMessage): string =>
  Match.value(message).pipe(
    Match.tag("Down", () => "rotating_light"),
    Match.tag("NotChecked", () => "warning"),
    Match.tag("Test", () => "test_tube"),
    Match.orElse(() => "white_check_mark")
  );

export interface AlertRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

/** The JSON bodies sent to Slack, Discord and generic webhooks. */
type JsonBody =
  | { readonly text: string }
  | {
      readonly allowed_mentions: { readonly parse: readonly string[] };
      readonly content: string;
    }
  | WebhookPayload;

const json = (
  url: string,
  body: JsonBody,
  headers: Readonly<Record<string, string>> = {}
): AlertRequest => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
  url,
});

/**
 * The POST request that delivers `message` to a channel of `kind` at `url`:
 *
 * - `slack`: incoming webhook, `{ text }`.
 * - `discord`: webhook, `{ content }` with mentions disabled.
 * - `webhook`: generic JSON ({@link webhookPayload}) with an
 *   `Idempotency-Key` header equal to the body's `id`.
 * - `ntfy`: the message as plain text to the topic URL; title, priority and
 *   tags go in query parameters (they may contain UTF-8).
 */
export const alertRequest = (
  kind: ChannelKind,
  url: string,
  message: AlertMessage
): AlertRequest => {
  switch (kind) {
    case "slack": {
      return json(url, { text: plainText(message) });
    }
    case "discord": {
      return json(url, {
        allowed_mentions: { parse: [] },
        content: plainText(message).slice(0, discordMaxLength),
      });
    }
    case "webhook": {
      return json(url, webhookPayload(message), {
        "idempotency-key": message.idempotencyKey,
      });
    }
    case "ntfy": {
      const text = alertText(message);
      const target = new URL(url);
      target.searchParams.set("title", `Kanshi: ${text.title}`);
      target.searchParams.set("priority", ntfyPriority(message));
      target.searchParams.set("tags", ntfyTags(message));
      return {
        body: text.body,
        headers: { "content-type": "text/plain; charset=utf-8" },
        url: target.toString(),
      };
    }
    default: {
      return kind satisfies never;
    }
  }
};
