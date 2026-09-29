// The `?redirect=` of the login page: where to go back after signing in.
// Only a path on this site is followed (no `//host`, no scheme), so the
// parameter cannot send a user elsewhere.

/** Whether `target` is a same-site path worth returning to. */
export const isSafeRedirect = (target: string): boolean =>
  target.startsWith("/") &&
  !target.startsWith("//") &&
  !target.startsWith("/\\") &&
  !/^\/login(?:[/?#]|$)/u.test(target);

/** `target` when it is safe, else the dashboard. */
export const redirectTarget = (target?: string): string =>
  target !== undefined && isSafeRedirect(target) ? target : "/";
