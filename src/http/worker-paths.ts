// Which request paths the Worker answers itself; everything else is the
// SPA (`web/`), served as static assets with `index.html` as the fallback.
// Shared by the Worker's assets config and the Vite dev server's proxy.

/** The HTTP API and, in the dev stage, the `/_dev/*` fixtures. */
export const apiPrefixes = ["/api", "/_dev"] as const;

/**
 * Every prefix the Worker answers before the static assets. The legacy
 * server-rendered pages (`/login`, `/logout`, `/monitors`, `/channels`)
 * are retired: those paths are the SPA's now.
 */
export const workerPrefixes: readonly string[] = [...apiPrefixes];

/**
 * Cloudflare `run_worker_first` rules: each prefix and everything below
 * it. Other paths never reach the Worker: an asset, or `index.html`.
 */
export const runWorkerFirst = workerPrefixes.flatMap((prefix) => [
  prefix,
  `${prefix}/*`,
]);

/**
 * Local runtime only (`alchemy dev`, the integration tests): its
 * `/cdn-cgi/handler/*` routes (the cron timer, firing a cron by hand) sit
 * behind the asset router, so they must be routed Worker-first too.
 * Cloudflare's edge answers `/cdn-cgi/` itself, so deploys leave it out.
 */
export const localRunWorkerFirst = [...runWorkerFirst, "/cdn-cgi/handler/*"];

/** Whether `pathname` is one of the Worker's own paths. */
export const isWorkerPath = (pathname: string): boolean =>
  workerPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
