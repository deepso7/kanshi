import * as Data from "effect/Data";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { ChannelKind } from "../domain/channel.ts";
import type { ResponseExcerpt } from "../domain/monitor.ts";

export interface AlertMonitor {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface AlertIncident {
  readonly cause: string;
  readonly id: string;
  readonly lastHttpStatus: number | null;
  /** The opening check's latency. */
  readonly latencyMs: number | null;
  readonly resolvedAt: number | null;
  /** The start of the opening check's response body. */
  readonly responseExcerpt: ResponseExcerpt | null;
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

/** How an alert is coloured and marked: red, green, amber or neutral. */
type Tone = "down" | "info" | "up" | "warning";

interface AlertField {
  /** Short enough to share a row with other inline fields. */
  readonly inline: boolean;
  readonly name: string;
  readonly value: string;
}

/**
 * An alert's content, before it is shaped for a channel kind. `title` has
 * no emoji (chat formats add `emoji`); `summary` is the plain-text detail
 * (for text channels, and chat alerts without fields).
 */
interface AlertContent {
  /** When it happened: the outage or episode start, or its end. */
  readonly at: number;
  readonly emoji: string;
  readonly excerpt: ResponseExcerpt | null;
  readonly fields: readonly AlertField[];
  /** Ping the whole channel: only a (fresh) down alert does. */
  readonly mention: boolean;
  readonly summary: string | null;
  readonly title: string;
  readonly tone: Tone;
  /** The monitor's URL; null for a test alert. */
  readonly url: string | null;
}

const emojis: Readonly<Record<Tone, string>> = {
  down: "🔴",
  info: "🧪",
  up: "🟢",
  warning: "🟠",
};

/** What the opening check saw: cause, HTTP status, latency. */
const failureFields = (incident: AlertIncident): AlertField[] => [
  { inline: false, name: "Cause", value: incident.cause },
  ...(incident.lastHttpStatus === null
    ? []
    : [
        {
          inline: true,
          name: "HTTP status",
          value: `${incident.lastHttpStatus}`,
        },
      ]),
  ...(incident.latencyMs === null
    ? []
    : [{ inline: true, name: "Latency", value: `${incident.latencyMs} ms` }]),
];

const incidentContent = (
  alert: IncidentAlert,
  tone: Tone,
  fields: readonly AlertField[],
  rest: Pick<AlertContent, "at" | "excerpt" | "mention" | "summary" | "title">
): AlertContent => ({
  ...rest,
  emoji: emojis[tone],
  fields,
  tone,
  url: alert.monitor.url,
});

const episodeContent = (
  alert: EpisodeAlert,
  tone: Tone,
  fields: readonly AlertField[],
  rest: Pick<AlertContent, "at" | "summary" | "title">
): AlertContent => ({
  ...rest,
  emoji: emojis[tone],
  excerpt: null,
  fields,
  mention: false,
  tone,
  url: alert.monitor.url,
});

const alertContent = (message: AlertMessage): AlertContent =>
  AlertMessage.$match(message, {
    CheckedAgain: (alert) => {
      const duration = formatDuration(uncheckedMs(alert.episode, alert.sentAt));
      return episodeContent(
        alert,
        "up",
        [{ inline: true, name: "Not checked for", value: duration }],
        {
          at: alert.episode.resolvedAt ?? alert.sentAt,
          summary: null,
          title: `monitor ${alert.monitor.name} is being checked again after ${duration}`,
        }
      );
    },
    Down: (alert) =>
      incidentContent(alert, "down", failureFields(alert.incident), {
        at: alert.incident.startedAt,
        excerpt: alert.incident.responseExcerpt,
        mention: true,
        summary: alert.incident.cause,
        title: `${alert.monitor.name} is down`,
      }),
    DownRecovered: (alert) => {
      const duration = formatDuration(outageMs(alert.incident, alert.sentAt));
      return incidentContent(
        alert,
        "up",
        [
          ...failureFields(alert.incident),
          { inline: true, name: "Down for", value: duration },
        ],
        {
          at: alert.incident.resolvedAt ?? alert.sentAt,
          excerpt: alert.incident.responseExcerpt,
          mention: false,
          summary: `Cause: ${alert.incident.cause}`,
          title: `${alert.monitor.name} was down for ${duration}, recovered`,
        }
      );
    },
    NotChecked: (alert) => {
      const last =
        alert.episode.lastCheckedAt === null
          ? "never"
          : `${formatDuration(alert.sentAt - alert.episode.lastCheckedAt)} ago`;
      const every = formatDuration(alert.episode.intervalSeconds * 1000);
      return episodeContent(
        alert,
        "warning",
        [
          { inline: true, name: "Last check", value: last },
          { inline: true, name: "Expected every", value: every },
        ],
        {
          at: alert.episode.startedAt,
          summary: `Last check: ${last} (expected every ${every})`,
          title: `monitor ${alert.monitor.name} is not being checked`,
        }
      );
    },
    NotCheckedResolved: (alert) => {
      const duration = formatDuration(uncheckedMs(alert.episode, alert.sentAt));
      return episodeContent(
        alert,
        "up",
        [{ inline: true, name: "Not checked for", value: duration }],
        {
          at: alert.episode.resolvedAt ?? alert.sentAt,
          summary: null,
          title: `monitor ${alert.monitor.name} was not checked for ${duration}, checks resumed`,
        }
      );
    },
    Recovered: (alert) => {
      const duration = formatDuration(outageMs(alert.incident, alert.sentAt));
      return incidentContent(
        alert,
        "up",
        [
          { inline: true, name: "Down for", value: duration },
          { inline: false, name: "Cause", value: alert.incident.cause },
        ],
        {
          at: alert.incident.resolvedAt ?? alert.sentAt,
          excerpt: null,
          mention: false,
          summary: `Down for ${duration}`,
          title: `${alert.monitor.name} recovered`,
        }
      );
    },
    Test: (alert): AlertContent => ({
      at: alert.sentAt,
      emoji: emojis.info,
      excerpt: null,
      fields: [],
      mention: false,
      summary: "If you can read this, alerts reach this channel.",
      title: `Test alert for channel "${alert.channelName}"`,
      tone: "info",
      url: null,
    }),
  });

export interface AlertText {
  /** One line: what happened. */
  readonly title: string;
  /** Details: cause, duration, target. */
  readonly body: string;
}

/** The plain-text alert: what the generic webhook carries as `text`. */
export const alertText = (message: AlertMessage): AlertText => {
  const content = alertContent(message);
  return {
    body: [content.summary, content.url].filter(Predicate.isNotNull).join("\n"),
    title: content.title,
  };
};

/** Appended to an excerpt that was cut, by the probe or to fit a limit. */
export const truncatedMarker = "…(truncated)";

const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown)
);

/** The excerpt pretty-printed (2-space indent) if it is a JSON object or array. */
const prettyJson = (text: string): Option.Option<string> =>
  decodeJson(text).pipe(
    Option.filter(Predicate.isObjectOrArray),
    Option.map((value) => JSON.stringify(value, null, 2))
  );

/**
 * The first `max` UTF-16 units of `text`, never splitting a surrogate
 * pair.
 */
const cut = (text: string, max: number): string => {
  const head = text.slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/u.test(head) ? head.slice(0, -1) : head;
};

/** `text` cut to `max` characters, ending in `…` if it was cut. */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${cut(text, max - 1)}…`;

/**
 * Break every run of backticks with zero-width spaces, so the body can
 * never close (or open) a code fence.
 */
const escapeFences = (text: string): string =>
  text.replaceAll(/`(?=`)/gu, "`\u200B");

interface CodeBlockOptions {
  /** Tag a JSON excerpt ```json (Discord highlights it; Slack cannot). */
  readonly language: boolean;
  /** The whole block, marker included, fits in this many characters. */
  readonly maxLength: number;
  /** Applied to the body after fence escaping (Slack's `&<>` escapes). */
  readonly escape?: (text: string) => string;
}

/**
 * The excerpt as a Markdown code block: pretty-printed JSON if it parses
 * as a JSON object or array, else the text as is. Fences inside are
 * broken up; a body cut by the probe or to fit `maxLength` is followed by
 * {@link truncatedMarker}.
 */
export const excerptBlock = (
  excerpt: ResponseExcerpt,
  options: CodeBlockOptions
): string => {
  const json = prettyJson(excerpt.text);
  const escape = options.escape ?? ((text: string) => text);
  const body = escape(escapeFences(Option.getOrElse(json, () => excerpt.text)));
  const open = `\`\`\`${options.language && Option.isSome(json) ? "json" : ""}\n`;
  const close = "\n```";
  const marker = `\n${truncatedMarker}`;
  const room = options.maxLength - open.length - close.length;
  if (!excerpt.truncated && body.length <= room) {
    return `${open}${body}${close}`;
  }
  // Drop a trailing partial `&amp;`-style escape along with the cut.
  const head = cut(body, room - marker.length).replace(/&[a-z]*$/u, "");
  return `${open}${head}${close}${marker}`;
};

/** The excerpt as plain text, cut to `maxLength` with the marker. */
const excerptText = (excerpt: ResponseExcerpt, maxLength: number): string => {
  const body = Option.getOrElse(prettyJson(excerpt.text), () => excerpt.text);
  const marker = `\n${truncatedMarker}`;
  if (!excerpt.truncated && body.length <= maxLength) {
    return body;
  }
  return `${cut(body, maxLength - marker.length)}${marker}`;
};

/** Discord embed colours (its own red, green, amber and blurple). */
const discordColors: Readonly<Record<Tone, number>> = {
  down: 0xed_42_45,
  info: 0x58_65_f2,
  up: 0x57_f2_87,
  warning: 0xf0_b2_32,
};

/** Discord's limits, in characters. */
const discordLimits = {
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  title: 256,
  /** Title, description, field names and values together. */
  total: 6000,
};

interface DiscordField {
  readonly inline: boolean;
  readonly name: string;
  readonly value: string;
}

interface DiscordEmbed {
  readonly color: number;
  description?: string;
  fields?: readonly DiscordField[];
  /** ISO 8601. */
  readonly timestamp: string;
  readonly title: string;
  url?: string;
}

/** A Discord execute-webhook body. */
export interface DiscordPayload {
  readonly allowed_mentions: { readonly parse: readonly "everyone"[] };
  content?: string;
  readonly embeds: readonly DiscordEmbed[];
}

/** The embed's description: the excerpt, else the summary if no fields. */
const discordDescription = (
  content: AlertContent,
  hasFields: boolean,
  room: number
): string | null => {
  if (content.excerpt !== null) {
    return excerptBlock(content.excerpt, { language: true, maxLength: room });
  }
  return hasFields || content.summary === null
    ? null
    : clip(content.summary, room);
};

/**
 * A Discord webhook body: one embed (title linked to the monitor, colour
 * per tone, fields, the excerpt as the description, timestamp). A down
 * alert says `@everyone` in `content` and allows exactly that mention;
 * every other alert allows none.
 */
export const discordPayload = (message: AlertMessage): DiscordPayload => {
  const content = alertContent(message);
  const title = clip(`${content.emoji} ${content.title}`, discordLimits.title);
  const fields = content.fields.map((field): DiscordField => ({
    inline: field.inline,
    name: clip(field.name, discordLimits.fieldName),
    value: clip(field.value, discordLimits.fieldValue),
  }));
  const used =
    title.length +
    fields.reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0
    );
  const description = discordDescription(
    content,
    fields.length > 0,
    Math.min(discordLimits.description, discordLimits.total - used)
  );
  const embed: DiscordEmbed = {
    color: discordColors[content.tone],
    timestamp: new Date(content.at).toISOString(),
    title,
  };
  if (description !== null) {
    embed.description = description;
  }
  if (fields.length > 0) {
    embed.fields = fields;
  }
  if (content.url !== null) {
    embed.url = content.url;
  }
  const payload: DiscordPayload = {
    allowed_mentions: { parse: content.mention ? ["everyone"] : [] },
    embeds: [embed],
  };
  if (content.mention) {
    payload.content = "@everyone";
  }
  return payload;
};

/** Slack's limits, in characters. */
const slackLimits = {
  fieldText: 2000,
  fields: 10,
  header: 150,
  sectionText: 3000,
};

/** Slack's required escapes in `mrkdwn` text. */
const slackEscape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A `<url|label>` link; the URL must not carry `|` or `>`. */
const slackLink = (url: string): string =>
  `<${url.replaceAll("|", "%7C").replaceAll(">", "%3E")}|${slackEscape(url)}>`;

const mrkdwn = (text: string) => ({ text, type: "mrkdwn" as const });

/**
 * A Slack incoming-webhook body in Block Kit: a header (emoji and title),
 * the monitor link (after `<!channel>` on a down alert), the fields, the
 * excerpt as a code block and the time. `text` is the notification
 * fallback.
 */
export const slackPayload = (message: AlertMessage) => {
  const content = alertContent(message);
  const heading = `${content.emoji} ${content.title}`;
  const lead = [
    content.mention ? "<!channel>" : null,
    content.url === null ? null : slackLink(content.url),
  ].filter(Predicate.isNotNull);
  const fields = content.fields
    .slice(0, slackLimits.fields)
    .map((field) =>
      mrkdwn(
        clip(
          `*${slackEscape(field.name)}*\n${slackEscape(field.value)}`,
          slackLimits.fieldText
        )
      )
    );
  const seconds = Math.floor(content.at / 1000);
  const iso = new Date(content.at).toISOString();
  const blocks = [
    {
      text: {
        emoji: true,
        text: clip(heading, slackLimits.header),
        type: "plain_text" as const,
      },
      type: "header" as const,
    },
    ...(lead.length === 0
      ? []
      : [{ text: mrkdwn(lead.join(" ")), type: "section" as const }]),
    ...(fields.length === 0 ? [] : [{ fields, type: "section" as const }]),
    ...(fields.length === 0 && content.summary !== null
      ? [
          {
            text: mrkdwn(
              clip(slackEscape(content.summary), slackLimits.sectionText)
            ),
            type: "section" as const,
          },
        ]
      : []),
    ...(content.excerpt === null
      ? []
      : [
          {
            text: mrkdwn(
              excerptBlock(content.excerpt, {
                escape: slackEscape,
                language: false,
                maxLength: slackLimits.sectionText,
              })
            ),
            type: "section" as const,
          },
        ]),
    {
      elements: [
        mrkdwn(`<!date^${seconds}^{date_short_pretty} at {time}|${iso}>`),
      ],
      type: "context" as const,
    },
  ];
  return {
    blocks,
    text: `${content.mention ? "<!channel> " : ""}${slackEscape(heading)}`,
  };
};

export type SlackPayload = ReturnType<typeof slackPayload>;

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
  responseExcerpt: null,
  responseTruncated: false,
  sentAt: alert.sentAt,
  text: `${text.title}\n${text.body}`,
  title: text.title,
});

const incidentPayload = (
  alert: IncidentAlert,
  text: AlertText,
  event: "down" | "up",
  recovered: boolean
) => {
  const { responseExcerpt, ...incident } = alert.incident;
  return {
    event,
    id: alert.idempotencyKey,
    incident: {
      ...incident,
      durationMs: outageMs(alert.incident, alert.sentAt),
    },
    monitor: alert.monitor,
    recovered,
    responseExcerpt: responseExcerpt?.text ?? null,
    responseTruncated: responseExcerpt?.truncated ?? false,
    sentAt: alert.sentAt,
    text: `${text.title}\n${text.body}`,
    title: text.title,
  };
};

/**
 * The generic webhook JSON body. `responseExcerpt` is the start of the
 * failing response's body (null without one, and on recovery alerts),
 * `responseTruncated` whether the body went on past it.
 */
export const webhookPayload = (message: AlertMessage) => {
  const text = alertText(message);
  return AlertMessage.$match(message, {
    CheckedAgain: (alert) => episodePayload(alert, text, true),
    Down: (alert) => incidentPayload(alert, text, "down", false),
    DownRecovered: (alert) => incidentPayload(alert, text, "down", true),
    NotChecked: (alert) => episodePayload(alert, text, false),
    NotCheckedResolved: (alert) => episodePayload(alert, text, true),
    Recovered: (alert) =>
      incidentPayload(
        { ...alert, incident: { ...alert.incident, responseExcerpt: null } },
        text,
        "up",
        true
      ),
    Test: (alert) => ({
      event: "test",
      id: alert.idempotencyKey,
      incident: null,
      monitor: null,
      recovered: false,
      responseExcerpt: null,
      responseTruncated: false,
      sentAt: alert.sentAt,
      text: `${text.title}\n${text.body}`,
      title: text.title,
    }),
  });
};

export type WebhookPayload = ReturnType<typeof webhookPayload>;

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

/**
 * ntfy turns a message over 4096 bytes into an attachment (or rejects
 * it); the excerpt is cut to keep well under that.
 */
const ntfyExcerptChars = 3000;
const ntfyMaxBytes = 4000;

/** `text` cut to at most `max` UTF-8 bytes, on a character boundary. */
const fitBytes = (text: string, max: number): string => {
  const bytes = new TextEncoder().encode(text);
  return bytes.byteLength <= max
    ? text
    : new TextDecoder().decode(bytes.subarray(0, max), { stream: true });
};

/**
 * The ntfy message: the summary, then the excerpt as plain text (the
 * monitor URL when there is neither; it is also the click-through).
 */
const ntfyBody = (content: AlertContent): string => {
  const parts = [
    content.summary,
    content.excerpt === null
      ? null
      : excerptText(content.excerpt, ntfyExcerptChars),
  ].filter(Predicate.isNotNull);
  return fitBytes(
    parts.length === 0 ? (content.url ?? content.title) : parts.join("\n\n"),
    ntfyMaxBytes
  );
};

export interface AlertRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

/** The JSON bodies sent to Slack, Discord and generic webhooks. */
type JsonBody = DiscordPayload | SlackPayload | WebhookPayload;

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
 * - `slack`: incoming webhook, Block Kit ({@link slackPayload}).
 * - `discord`: webhook, one embed ({@link discordPayload}); `@everyone`
 *   on down alerts only.
 * - `webhook`: generic JSON ({@link webhookPayload}) with an
 *   `Idempotency-Key` header equal to the body's `id`.
 * - `ntfy`: the message as plain text to the topic URL; title, priority,
 *   tags and the click-through URL go in query parameters (ntfy reads the
 *   same names as headers or parameters; parameters may carry UTF-8).
 */
export const alertRequest = (
  kind: ChannelKind,
  url: string,
  message: AlertMessage
): AlertRequest => {
  switch (kind) {
    case "slack": {
      return json(url, slackPayload(message));
    }
    case "discord": {
      return json(url, discordPayload(message));
    }
    case "webhook": {
      return json(url, webhookPayload(message), {
        "idempotency-key": message.idempotencyKey,
      });
    }
    case "ntfy": {
      const content = alertContent(message);
      const target = new URL(url);
      target.searchParams.set("title", content.title);
      target.searchParams.set("priority", ntfyPriority(message));
      target.searchParams.set("tags", ntfyTags(message));
      if (content.url !== null) {
        target.searchParams.set("click", content.url);
      }
      return {
        body: ntfyBody(content),
        headers: { "content-type": "text/plain; charset=utf-8" },
        url: target.toString(),
      };
    }
    default: {
      return kind satisfies never;
    }
  }
};
