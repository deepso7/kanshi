// What each Alchemy stage gets: pure, so the stacks and the unit tests
// share one policy. Stages: `dev` (`pnpm dev`, local), `prod` (`pnpm run
// deploy`, Cloudflare) and the integration tests' `integ-*` (local, own
// stack).

/** The stage `pnpm run deploy` / `pnpm run destroy` target. */
export const deployStage = "prod";

/**
 * Stages that get dev mode: `/_dev/*` fixtures, 5s intervals, localhost.
 * Only when the Worker runs locally (`alchemy dev`): `alchemy deploy
 * --stage dev` to Cloudflare deploys without dev mode. The Worker also
 * serves `/_dev/*` only to requests for a loopback host.
 */
export const devStages: ReadonlySet<string> = new Set(["dev"]);

/**
 * The deployed Worker's script name, giving
 * `https://kanshi.<account-subdomain>.workers.dev`. A DNS label: lowercase
 * letters, digits and dashes (Alchemy uses an explicit name as is).
 */
export const deployWorkerName = "kanshi";

/**
 * The Worker's name for `stage`: {@link deployWorkerName} for the deploy
 * stage; otherwise `undefined`, so Alchemy derives a distinct
 * `<stack>-kanshi-<stage>-<random>` name that never clashes with it.
 */
export const workerNameFor = (stage: string): string | undefined =>
  stage === deployStage ? deployWorkerName : undefined;
