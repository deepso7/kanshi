import * as HttpClientError from "effect/http/HttpClientError";
// What a failed API call means to the user. `callApi` rejects with the
// typed error itself: the spec's `NotFound` / `BadRequest` / `Conflict` /
// `Unavailable` (each with the server's `message`), the auth middleware's
// `Unauthorized` / `Forbidden`, or the client's `HttpClientError` (the
// network, or a reply that did not decode).
import * as Predicate from "effect/Predicate";

/** A failure, ready to show: a short title and a sentence. */
export interface ErrorView {
  readonly title: string;
  readonly message: string;
  /** The HTTP status, when the server answered. */
  readonly status: number | null;
}

interface KnownError {
  readonly tag: string;
  readonly status: number;
  readonly title: string;
  /** Used when the error carries no message of its own. */
  readonly fallback: string;
}

const knownErrors: readonly KnownError[] = [
  {
    fallback: "Your session has ended. Sign in again.",
    status: 401,
    tag: "Unauthorized",
    title: "Signed out",
  },
  {
    fallback: "The request was refused: it did not come from this site.",
    status: 403,
    tag: "Forbidden",
    title: "Refused",
  },
  {
    fallback: "It does not exist, or it was deleted.",
    status: 404,
    tag: "NotFound",
    title: "Not found",
  },
  {
    fallback: "The request was not valid.",
    status: 400,
    tag: "BadRequest",
    title: "Invalid",
  },
  {
    fallback: "That conflicts with the current state.",
    status: 409,
    tag: "Conflict",
    title: "Conflict",
  },
  {
    fallback: "Kanshi is busy. Try again in a moment.",
    status: 503,
    tag: "Unavailable",
    title: "Try again",
  },
];

/** A 401: the session is missing or expired (the app signs out). */
export const isUnauthorized = (error: Error | null): boolean =>
  Predicate.isTagged(error, "Unauthorized");

/** A 404 from the API (an unknown or deleted monitor or channel). */
export const isNotFound = (error: Error | null): boolean =>
  Predicate.isTagged(error, "NotFound");

/** The network failed, or the reply could not be read. */
export const isConnectionError = (error: Error | null): boolean =>
  HttpClientError.isHttpClientError(error);

/** The title and message to show for any error an API call rejects with. */
export const describeError = (error: Error): ErrorView => {
  const own = error.message.trim();
  const known = knownErrors.find((entry) =>
    Predicate.isTagged(error, entry.tag)
  );
  if (known !== undefined) {
    return {
      message: own === "" ? known.fallback : own,
      status: known.status,
      title: known.title,
    };
  }
  if (isConnectionError(error)) {
    return {
      message: "Could not reach Kanshi. Check the connection and try again.",
      status: null,
      title: "Connection lost",
    };
  }
  return {
    message: own === "" ? "An unexpected error occurred." : own,
    status: null,
    title: "Something went wrong",
  };
};

/**
 * TanStack Query's `retry` for reads: only what a retry can fix (the
 * network, a 503), twice. A 4xx fails at once (a 401 signs out at once).
 */
export const shouldRetry = (failureCount: number, error: Error): boolean =>
  failureCount < 2 &&
  (isConnectionError(error) || Predicate.isTagged(error, "Unavailable"));
