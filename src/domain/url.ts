import * as Result from "effect/Result";

/**
 * URL rules applied when a monitor target is saved. There is one trusted
 * operator and Workers `fetch` cannot reach private networks, so hostnames
 * are not resolved; this only rejects obviously local targets.
 */
export type UrlRejection =
  | "blocked_hostname"
  | "credentials_not_allowed"
  | "invalid_url"
  | "private_address"
  | "protocol_not_allowed";

export interface TargetUrlOptions {
  /**
   * Allow loopback targets (`localhost`, `127.0.0.1`, `[::1]`) over http or
   * https. Only the dev stage sets this, for its `/_dev/*` fixtures.
   */
  readonly allowLoopback: boolean;
}

const localHostnameSuffixes = [
  ".home",
  ".internal",
  ".lan",
  ".local",
  ".localhost",
];

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

const isLoopback = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return true;
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    return ipv4[0] === 127;
  }
  const ipv6 = parseIpv6(hostname);
  return (
    ipv6 !== undefined &&
    ipv6.slice(0, 7).every((group) => group === 0) &&
    ipv6[7] === 1
  );
};

const isBlockedHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  !hostname.includes(".") ||
  localHostnameSuffixes.some((suffix) => hostname.endsWith(suffix));

const hasScheme = /^[a-z][\d+.a-z-]*:/iu;

/**
 * Validate and normalise a probe target URL. A URL without a scheme gets
 * `https://`. Returns the normalised URL string.
 */
export const checkTargetUrl = (
  input: string,
  options: TargetUrlOptions
): Result.Result<string, UrlRejection> => {
  const trimmed = input.trim();
  const candidate = hasScheme.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) {
    return Result.fail("invalid_url");
  }
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Result.fail("protocol_not_allowed");
  }
  if (url.username || url.password) {
    return Result.fail("credentials_not_allowed");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (hostname.length === 0) {
    return Result.fail("invalid_url");
  }
  if (options.allowLoopback && isLoopback(hostname)) {
    return Result.succeed(url.toString());
  }
  if (isIpAddress(hostname)) {
    return isPublicIpAddress(hostname)
      ? Result.succeed(url.toString())
      : Result.fail("private_address");
  }
  if (isBlockedHostname(hostname)) {
    return Result.fail("blocked_hostname");
  }
  return Result.succeed(url.toString());
};

export const describeUrlRejection = (rejection: UrlRejection): string => {
  switch (rejection) {
    case "blocked_hostname": {
      return "local hostnames are not allowed";
    }
    case "credentials_not_allowed": {
      return "URLs must not contain credentials";
    }
    case "invalid_url": {
      return "invalid URL";
    }
    case "private_address": {
      return "private and reserved IP addresses are not allowed";
    }
    case "protocol_not_allowed": {
      return "only http and https URLs are allowed";
    }
    default: {
      return rejection satisfies never;
    }
  }
};
