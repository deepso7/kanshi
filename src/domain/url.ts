import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const DnsAnswer = Schema.Struct({
  data: Schema.String,
  type: Schema.Int,
});

const DnsResponse = Schema.Struct({
  Answer: Schema.optionalKey(Schema.Array(DnsAnswer)),
  Status: Schema.Int,
});

const UrlValidationReason = Schema.Literals([
  "blocked_hostname",
  "credentials_not_allowed",
  "dns_lookup_failed",
  "dns_resolver_failed",
  "invalid_url",
  "invalid_webhook",
  "no_public_address",
  "private_address",
  "protocol_not_allowed",
]);

export class UrlValidationError extends Schema.TaggedErrorClass<UrlValidationError>()(
  "UrlValidationError",
  {
    hostname: Schema.String,
    reason: UrlValidationReason,
  }
) {}

export interface ProbeUrlOptions {
  readonly allowHttp?: boolean;
}

export type ValidatedProbeUrl = URL & Brand.Brand<"ValidatedProbeUrl">;
export type ValidatedWebhookUrl = URL & Brand.Brand<"ValidatedWebhookUrl">;

export type WebhookKind = "discord" | "slack";

const makeValidatedProbeUrl = Brand.nominal<ValidatedProbeUrl>();
const makeValidatedWebhookUrl = Brand.nominal<ValidatedWebhookUrl>();

const localHostnameSuffixes = [
  ".home",
  ".internal",
  ".lan",
  ".local",
  ".localhost",
];

const discordWebhookHosts = new Set([
  "canary.discord.com",
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
]);

const slackWebhookHosts = new Set(["hooks.slack-gov.com", "hooks.slack.com"]);

const parseIpv4 = (hostname: string): readonly number[] | undefined => {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets = parts.map(Number);
  return octets.every(
    (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255
  )
    ? octets
    : undefined;
};

const parseIpv6 = (hostname: string): readonly number[] | undefined => {
  const [unscopedAddress] = hostname
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .split("%", 1);
  const address = unscopedAddress;
  if (!address) {
    return undefined;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return undefined;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;

  if (
    missing < 0 ||
    (halves.length === 1 && missing !== 0) ||
    [...left, ...right].some((part) => !/^[\da-f]{1,4}$/iu.test(part))
  ) {
    return undefined;
  }

  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
};

const isPublicIpv4 = (octets: readonly number[]): boolean => {
  const [a = 0, b = 0, c = 0] = octets;
  const blocked = [
    a === 0,
    a === 10,
    a === 127,
    a === 100 && b >= 64 && b <= 127,
    a === 169 && b === 254,
    a === 172 && b >= 16 && b <= 31,
    a === 192 && b === 0 && (c === 0 || c === 2),
    a === 192 && b === 168,
    a === 198 && (b === 18 || b === 19),
    a === 198 && b === 51 && c === 100,
    a === 203 && b === 0 && c === 113,
    a >= 224,
  ];
  return !blocked.includes(true);
};

const isIpv4CompatibleIpv6 = (groups: readonly number[]): boolean =>
  groups.slice(0, 6).every((group) => group === 0);

const isIpv4MappedIpv6 = (groups: readonly number[]): boolean =>
  groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65_535;

const embeddedIpv4 = (groups: readonly number[]): readonly number[] => {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256];
};

const isPublicIpv6 = (groups: readonly number[]): boolean => {
  const first = groups[0] ?? 0;
  const second = groups[1] ?? 0;
  const prefix = Math.floor(first / 256);

  if (
    groups.every((group) => group === 0) ||
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
    (first >= 64_512 && first <= 65_023) ||
    (first >= 65_152 && first <= 65_215) ||
    (first >= 65_216 && first <= 65_279) ||
    prefix === 255 ||
    (first === 8193 && second === 3512)
  ) {
    return false;
  }

  if (isIpv4CompatibleIpv6(groups) || isIpv4MappedIpv6(groups)) {
    return isPublicIpv4(embeddedIpv4(groups));
  }

  return true;
};

export const isPublicIpAddress = (hostname: string): boolean => {
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    return isPublicIpv4(ipv4);
  }

  const ipv6 = parseIpv6(hostname);
  return ipv6 ? isPublicIpv6(ipv6) : false;
};

const isIpAddress = (hostname: string): boolean =>
  parseIpv4(hostname) !== undefined || parseIpv6(hostname) !== undefined;

const isBlockedHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  localHostnameSuffixes.some((suffix) => hostname.endsWith(suffix));

const parseUrl = Effect.fn("Url.parse")(function* parseUrlEffect(
  input: unknown
) {
  return yield* Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.mapError(
      () =>
        new UrlValidationError({
          hostname: "",
          reason: "invalid_url",
        })
    )
  );
});

const queryDns = Effect.fn("Url.queryDns")(function* queryDnsEffect(
  hostname: string,
  recordType: "A" | "AAAA"
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.get(
    "https://cloudflare-dns.com/dns-query"
  ).pipe(
    HttpClientRequest.setUrlParams({ name: hostname, type: recordType }),
    HttpClientRequest.accept("application/dns-json"),
    client.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DnsResponse)),
    Effect.mapError(
      () =>
        new UrlValidationError({
          hostname,
          reason: "dns_resolver_failed",
        })
    )
  );

  if (response.Status !== 0) {
    return yield* new UrlValidationError({
      hostname,
      reason: "dns_lookup_failed",
    });
  }

  const dnsType = recordType === "A" ? 1 : 28;
  return (response.Answer ?? [])
    .filter((answer) => answer.type === dnsType)
    .map((answer) => answer.data);
});

const validateResolvedHostname = Effect.fn("Url.validateResolvedHostname")(
  function* validateResolvedHostnameEffect(hostname: string) {
    // Defense in depth only: Workers fetch re-resolves the hostname and offers no
    // connect-to-pinned-IP primitive, so DNS rebinding cannot be fully prevented.
    const [ipv4, ipv6] = yield* Effect.all(
      [queryDns(hostname, "A"), queryDns(hostname, "AAAA")],
      { concurrency: 2 }
    );
    const addresses = [...ipv4, ...ipv6];

    if (addresses.length === 0) {
      return yield* new UrlValidationError({
        hostname,
        reason: "no_public_address",
      });
    }

    if (addresses.some((address) => !isPublicIpAddress(address))) {
      return yield* new UrlValidationError({
        hostname,
        reason: "private_address",
      });
    }
  }
);

export const validateProbeUrl = Effect.fn("Url.validateProbeUrl")(
  function* validateProbeUrlEffect(
    input: unknown,
    options: ProbeUrlOptions = {}
  ) {
    const url = yield* parseUrl(input);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");

    if (url.username || url.password) {
      return yield* new UrlValidationError({
        hostname,
        reason: "credentials_not_allowed",
      });
    }

    if (
      url.protocol !== "https:" &&
      !(options.allowHttp === true && url.protocol === "http:")
    ) {
      return yield* new UrlValidationError({
        hostname,
        reason: "protocol_not_allowed",
      });
    }

    if (isBlockedHostname(hostname)) {
      return yield* new UrlValidationError({
        hostname,
        reason: "blocked_hostname",
      });
    }

    if (isIpAddress(hostname)) {
      if (!isPublicIpAddress(hostname)) {
        return yield* new UrlValidationError({
          hostname,
          reason: "private_address",
        });
      }
    } else {
      yield* validateResolvedHostname(hostname);
    }

    return makeValidatedProbeUrl(url);
  }
);

export const validateWebhookUrl = Effect.fn("Url.validateWebhookUrl")(
  function* validateWebhookUrlEffect(input: unknown, kind: WebhookKind) {
    const url = yield* parseUrl(input);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");

    if (url.username || url.password) {
      return yield* new UrlValidationError({
        hostname,
        reason: "credentials_not_allowed",
      });
    }

    if (url.protocol !== "https:") {
      return yield* new UrlValidationError({
        hostname,
        reason: "protocol_not_allowed",
      });
    }

    const valid =
      kind === "slack"
        ? slackWebhookHosts.has(hostname) &&
          /^\/services\/[^/]+\/[^/]+\/[^/]+$/u.test(url.pathname)
        : discordWebhookHosts.has(hostname) &&
          /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+$/u.test(url.pathname);

    if (!valid || url.hash) {
      return yield* new UrlValidationError({
        hostname,
        reason: "invalid_webhook",
      });
    }

    return makeValidatedWebhookUrl(url);
  }
);
