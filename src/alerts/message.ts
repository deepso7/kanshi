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

/**
 * What a channel is told. `DownRecovered` is a `down` alert sent after the
 * incident already recovered ("was down for Xm, recovered"); the separate
 * recovery alert is then skipped.
 */
export type AlertMessage =
  | {
      readonly _tag: "Down" | "DownRecovered" | "Recovered";
      readonly idempotencyKey: string;
      readonly incident: AlertIncident;
      readonly monitor: AlertMonitor;
      readonly sentAt: number;
    }
  | {
      readonly _tag: "Test";
      readonly channelName: string;
      readonly idempotencyKey: string;
      readonly sentAt: number;
    };

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

export interface AlertText {
  /** One line: what happened. */
  readonly title: string;
  /** Details: cause, duration, target. */
  readonly body: string;
}

/** The human-readable alert, shared by every channel kind. */
export const alertText = (message: AlertMessage): AlertText => {
  switch (message._tag) {
    case "Down": {
      return {
        body: `${message.incident.cause}\n${message.monitor.url}`,
        title: `${message.monitor.name} is down`,
      };
    }
    case "DownRecovered": {
      const duration = formatDuration(
        outageMs(message.incident, message.sentAt)
      );
      return {
        body: `Cause: ${message.incident.cause}\n${message.monitor.url}`,
        title: `${message.monitor.name} was down for ${duration}, recovered`,
      };
    }
    case "Recovered": {
      const duration = formatDuration(
        outageMs(message.incident, message.sentAt)
      );
      return {
        body: message.monitor.url,
        title: `${message.monitor.name} is up again after ${duration}`,
      };
    }
    case "Test": {
      return {
        body: "If you can read this, alerts reach this channel.",
        title: `Test alert for channel "${message.channelName}"`,
      };
    }
    default: {
      return message satisfies never;
    }
  }
};

const plainText = (message: AlertMessage): string => {
  const text = alertText(message);
  return `Kanshi: ${text.title}\n${text.body}`;
};

/** The generic webhook JSON body. */
export const webhookPayload = (message: AlertMessage) => {
  const text = alertText(message);
  if (message._tag === "Test") {
    return {
      event: "test",
      id: message.idempotencyKey,
      incident: null,
      monitor: null,
      recovered: false,
      sentAt: message.sentAt,
      text: `${text.title}\n${text.body}`,
      title: text.title,
    };
  }
  return {
    event: message._tag === "Recovered" ? "up" : "down",
    id: message.idempotencyKey,
    incident: {
      ...message.incident,
      durationMs: outageMs(message.incident, message.sentAt),
    },
    monitor: message.monitor,
    recovered: message._tag !== "Down",
    sentAt: message.sentAt,
    text: `${text.title}\n${text.body}`,
    title: text.title,
  };
};

/** Discord rejects message content over 2000 characters. */
const discordMaxLength = 2000;

const ntfyPriority = (message: AlertMessage): string => {
  switch (message._tag) {
    case "Down": {
      return "high";
    }
    case "Test": {
      return "low";
    }
    default: {
      return "default";
    }
  }
};

const ntfyTags = (message: AlertMessage): string => {
  switch (message._tag) {
    case "Down": {
      return "rotating_light";
    }
    case "Test": {
      return "test_tube";
    }
    default: {
      return "white_check_mark";
    }
  }
};

export interface AlertRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

const json = (
  url: string,
  body: unknown,
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
