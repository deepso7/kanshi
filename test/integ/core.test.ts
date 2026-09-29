// Integration tests for the core: run the Worker locally (alchemy dev mode,
// offline) and drive monitors with real alarms at 5s intervals against the
// `/_dev/*` fixtures. Run with `pnpm test:integ` (not while `pnpm dev` runs:
// both use port 1337).
import { expect } from "bun:test";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import {
  MonitorListItem,
  MonitorResponse,
  Overview,
} from "../../src/api/spec.ts";
import { monitorQuota } from "./alchemy.run.ts";
import type { RegistryCalls } from "./harness.ts";
import {
  ErrorBody,
  bodyOf,
  callsSince,
  checksOf,
  setup,
  statusOf,
  waitFor,
} from "./harness.ts";

const {
  create,
  detail,
  devUrl,
  registryCalls,
  registryRows,
  send,
  setFlip,
  test,
} = setup("integ");

test(
  "requires the bearer token and validates input",
  Effect.gen(function* authTest() {
    expect((yield* send("GET", "/api/monitors", { auth: null })).status).toBe(
      401
    );
    expect(
      (yield* send("GET", "/api/monitors", { auth: "wrong" })).status
    ).toBe(401);
    expect((yield* send("GET", "/api/unknown")).status).toBe(404);
    expect((yield* send("GET", "/api/monitors/missing")).status).toBe(404);

    const privateTarget = yield* send("POST", "/api/monitors", {
      body: { name: "private", url: "https://10.0.0.1/" },
    });
    expect(privateTarget.status).toBe(400);

    const key = `key-${crypto.randomUUID()}`;
    const monitor = yield* create({
      enabled: false,
      key,
      url: yield* devUrl("/target"),
    });
    const duplicate = yield* send("POST", "/api/monitors", {
      body: { key, name: "dup", url: yield* devUrl("/target") },
    });
    expect(duplicate.status).toBe(409);
    expect((yield* send("DELETE", `/api/monitors/${monitor.id}`)).status).toBe(
      204
    );

    // HEAD cannot check a body: rejected on create and on the merged
    // config of a patch; a rejected patch changes nothing, `public` included.
    const headKeyword = yield* send("POST", "/api/monitors", {
      body: {
        bodyContains: "ok",
        method: "HEAD",
        name: "head",
        url: yield* devUrl("/target"),
      },
    });
    expect(headKeyword.status).toBe(400);
    const keyword = yield* create({
      bodyContains: "ok",
      enabled: false,
      url: yield* devUrl("/target"),
    });
    const toHead = yield* send("PATCH", `/api/monitors/${keyword.id}`, {
      body: { method: "HEAD" },
    });
    expect(toHead.status).toBe(400);
    const toHeadPublic = yield* send("PATCH", `/api/monitors/${keyword.id}`, {
      body: { method: "HEAD", public: true },
    });
    expect(toHeadPublic.status).toBe(400);
    const unchanged = yield* send("GET", `/api/monitors/${keyword.id}`);
    expect(unchanged.body).toMatchObject({ method: "GET", public: false });
    const cleared = yield* send("PATCH", `/api/monitors/${keyword.id}`, {
      body: { bodyContains: null, method: "HEAD", public: true },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ method: "HEAD", public: true });
    yield* send("DELETE", `/api/monitors/${keyword.id}`);
  }),
  { timeout: 60_000 }
);

test(
  "goes down only after a confirm and recovers",
  Effect.gen(function* downAndRecoveryTest() {
    const flip = `flip-${crypto.randomUUID()}`;
    const monitor = yield* create({
      intervalSeconds: 5,
      url: yield* devUrl(`/target/flip/${flip}`),
    });
    yield* waitFor("up", detail(monitor.id), (d) => statusOf(d) === "up");

    yield* setFlip(flip, false);
    const down = yield* waitFor(
      "down",
      detail(monitor.id),
      (d) => statusOf(d) === "down"
    );
    const checks = checksOf(down);
    const firstFailure = checks.findIndex((check) => !check.ok);
    const failure = checks[firstFailure];
    const confirm = checks[firstFailure + 1];
    expect(failure?.kind).toBe("scheduled");
    expect(failure?.counted).toBe(false);
    expect(confirm?.kind).toBe("confirm");
    expect(confirm?.counted).toBe(true);
    expect(confirm?.ok).toBe(false);
    const gap = (confirm?.at ?? 0) - (failure?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(4000);
    expect(gap).toBeLessThan(8000);
    expect(down.incidents).toHaveLength(1);
    expect(down.incidents[0]?.resolvedAt).toBeNull();

    yield* setFlip(flip, true);
    const recovered = yield* waitFor(
      "recovered",
      detail(monitor.id),
      (d) => statusOf(d) === "up"
    );
    expect(recovered.incidents).toHaveLength(1);
    expect(recovered.incidents[0]?.resolution).toBe("recovered");

    // The Registry summary follows the monitor.
    yield* waitFor(
      "summary",
      send("GET", "/api/monitors").pipe(
        Effect.flatMap(bodyOf(Schema.Array(MonitorListItem)))
      ),
      (items) =>
        items.some((item) => item.id === monitor.id && item.status === "up")
    );
    yield* send("DELETE", `/api/monitors/${monitor.id}`);
  }),
  { timeout: 90_000 }
);

test(
  "disable closes the incident and stops checks, enable reopens, delete tombstones",
  Effect.gen(function* disableEnableDeleteTest() {
    const monitor = yield* create({
      intervalSeconds: 5,
      url: yield* devUrl("/target?status=500"),
    });
    yield* waitFor("down", detail(monitor.id), (d) => statusOf(d) === "down");

    const disabled = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    const disabledBody = yield* bodyOf(MonitorResponse)(disabled);
    expect(disabledBody.enabled).toBe(false);
    expect(disabledBody.state.status).toBe("unknown");
    expect(disabledBody.generation).toBe(1);

    const paused = yield* detail(monitor.id);
    // Only the daily maintenance keeps waking a disabled monitor.
    expect(paused.status.alarmAt).toBe(
      paused.status.snapshot?.state.nextMaintenanceAt ?? Number.NaN
    );
    expect(paused.incidents).toHaveLength(1);
    expect(paused.incidents[0]?.resolution).toBe("disabled");
    // Nothing is checked while disabled; a probe that was in flight is
    // discarded as stale.
    yield* Effect.sleep("8 seconds");
    expect((yield* detail(monitor.id)).checks).toHaveLength(
      paused.checks.length
    );

    const enabled = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    const reopened = yield* waitFor(
      "reopened",
      detail(monitor.id),
      (d) => statusOf(d) === "down" && d.incidents.length === 2
    );
    expect(
      reopened.incidents.filter((i) => i.resolvedAt === null)
    ).toHaveLength(1);

    expect((yield* send("DELETE", `/api/monitors/${monitor.id}`)).status).toBe(
      204
    );
    expect((yield* send("GET", `/api/monitors/${monitor.id}`)).status).toBe(
      404
    );
    expect(
      (yield* send("PATCH", `/api/monitors/${monitor.id}`, {
        body: { name: "x" },
      })).status
    ).toBe(404);
    expect((yield* send("DELETE", `/api/monitors/${monitor.id}`)).status).toBe(
      404
    );
    const gone = yield* detail(monitor.id);
    expect(gone.status.tombstonedAt).toBeNumber();
    expect(gone.status.alarmAt).toBeNull();
    expect(gone.status.snapshot).toBeNull();
    expect(gone.checks).toHaveLength(0);
    expect((yield* registryRows).some((row) => row.id === monitor.id)).toBe(
      false
    );
  }),
  { timeout: 120_000 }
);

test(
  "discards a probe result when the monitor is edited mid-probe",
  Effect.gen(function* staleResultTest() {
    const monitor = yield* create({
      intervalSeconds: 60,
      url: yield* devUrl("/target?delay=3000&status=500"),
    });
    yield* waitFor(
      "in flight",
      detail(monitor.id),
      (d) => d.status.snapshot?.state.inflight !== null
    );

    const edited = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { url: yield* devUrl("/target") },
    });
    expect(edited.status).toBe(200);
    expect((yield* bodyOf(MonitorResponse)(edited)).generation).toBe(1);

    yield* waitFor("checked", detail(monitor.id), (d) => d.checks.length > 0);
    // Let the stale 3s probe finish.
    yield* Effect.sleep("4 seconds");
    const after = yield* detail(monitor.id);
    expect(after.checks.every((check) => check.ok)).toBe(true);
    expect(after.checks.some((check) => check.status === 500)).toBe(false);
    expect(statusOf(after)).toBe("up");
    expect(after.incidents).toHaveLength(0);
    yield* send("DELETE", `/api/monitors/${monitor.id}`);
  }),
  { timeout: 60_000 }
);

test(
  "a manual check requested during an in-flight check is not lost",
  Effect.gen(function* manualDuringInflightTest() {
    const monitor = yield* create({
      intervalSeconds: 3600,
      url: yield* devUrl("/target?delay=2000"),
    });
    yield* waitFor(
      "in flight",
      detail(monitor.id),
      (d) => d.status.snapshot?.state.inflight !== null
    );
    // Two requests while the scheduled check runs collapse into one.
    for (const _ of [1, 2]) {
      const reply = yield* send("POST", `/api/monitors/${monitor.id}/check`);
      expect(reply.status).toBe(202);
    }

    yield* waitFor(
      "manual check",
      detail(monitor.id),
      (d) => d.checks.length >= 2,
      15_000
    );
    yield* Effect.sleep("3 seconds");
    const after = yield* detail(monitor.id);
    expect(checksOf(after).map((check) => check.kind)).toEqual([
      "scheduled",
      "manual",
    ]);
    expect(checksOf(after)[1]?.counted).toBe(false);
    expect(after.status.snapshot?.state.manualRequestedAt).toBeNull();
    // The scheduled slot is untouched: next check an interval after the first.
    const [first] = checksOf(after);
    expect(after.status.snapshot?.state.nextCheckKind).toBe("scheduled");
    expect(after.status.snapshot?.state.nextCheckAt).toBeGreaterThan(
      (first?.at ?? 0) + 3_500_000
    );
    yield* send("DELETE", `/api/monitors/${monitor.id}`);
  }),
  { timeout: 60_000 }
);

test(
  "deleting during a delayed configure leaves no running monitor",
  Effect.gen(function* deleteRacesConfigureTest() {
    const key = `race-${crypto.randomUUID()}`;
    const creating = yield* send("POST", "/api/monitors", {
      body: {
        intervalSeconds: 5,
        key,
        name: "race",
        url: yield* devUrl("/target"),
      },
      headers: { "x-kanshi-dev-configure-delay": "3000" },
    }).pipe(Effect.forkChild({ startImmediately: true }));

    const rows = yield* waitFor("creating row", registryRows, (entries) =>
      entries.some((row) => row.key === key)
    );
    const row = rows.find((entry) => entry.key === key);
    expect(row?.lifecycle).toBe("creating");
    const id = row?.id ?? "";

    expect((yield* send("DELETE", `/api/monitors/${id}`)).status).toBe(204);
    expect((yield* Fiber.join(creating)).status).toBe(409);

    expect((yield* registryRows).some((entry) => entry.id === id)).toBe(false);
    const gone = yield* detail(id);
    expect(gone.status.tombstonedAt).toBeNumber();
    expect(gone.status.snapshot).toBeNull();
    expect(gone.status.alarmAt).toBeNull();
    yield* Effect.sleep("6 seconds");
    const later = yield* detail(id);
    expect(later.checks).toHaveLength(0);
    expect(later.status.alarmAt).toBeNull();
  }),
  { timeout: 60_000 }
);

test(
  "enforces the monitor quota",
  Effect.gen(function* quotaTest() {
    const existing = (yield* registryRows).length;
    const url = yield* devUrl("/target");
    const created: string[] = [];
    for (let index = existing; index < monitorQuota; index += 1) {
      created.push((yield* create({ enabled: false, url })).id);
    }
    const over = yield* send("POST", "/api/monitors", {
      body: { enabled: false, name: "over", url },
    });
    expect(over.status).toBe(409);
    expect((yield* bodyOf(ErrorBody)(over)).message).toContain("quota");

    for (const id of created) {
      expect((yield* send("DELETE", `/api/monitors/${id}`)).status).toBe(204);
    }
    const again = yield* create({ enabled: false, url });
    yield* send("DELETE", `/api/monitors/${again.id}`);
  }),
  { timeout: 60_000 }
);

/** Registry methods only the dev fixtures or the cron call. */
const notFromChecks = new Set([
  "bumpDevCounter",
  "devEvents",
  "getFlip",
  "list",
  "reconcile",
  "recordDevEvent",
  "setFlip",
]);

/** Registry calls that a monitor's checks could have made, by method. */
const checkCalls = (calls: RegistryCalls) =>
  Object.fromEntries(
    Object.entries(calls.counts).filter(([name]) => !notFromChecks.has(name))
  );

test(
  "checks that change nothing make no Registry call; a status change is pushed; the overview reads the last check live",
  Effect.gen(function* leanUsageTest() {
    const target = yield* devUrl("/target");
    const monitor = yield* create({
      intervalSeconds: 5,
      name: `lean-${crypto.randomUUID()}`,
      url: target,
    });
    const listed = send("GET", "/api/monitors").pipe(
      Effect.flatMap(bodyOf(Schema.Array(MonitorListItem))),
      Effect.map((items) => items.find((item) => item.id === monitor.id))
    );
    // The first result (unknown -> up) is a status change: pushed.
    yield* waitFor(
      "up in the Registry",
      listed,
      (item) => item?.status === "up"
    );
    const checksNow = detail(monitor.id).pipe(
      Effect.map((value) => value.checks.length)
    );
    const before = yield* registryCalls;
    const startChecks = yield* checksNow;

    // Four more checks, polling the Registry's counter meanwhile (which
    // also keeps the same Registry instance running).
    yield* waitFor(
      "four more checks",
      Effect.zip(checksNow, registryCalls),
      ([count]) => count >= startChecks + 4,
      40_000
    );
    const after = yield* registryCalls;
    expect(callsSince(before, after, "upsertSummary")).toBe(0);
    expect(after.instanceId).toBe(before.instanceId);
    expect(checkCalls(after)).toEqual(checkCalls(before));

    // The overview shows the last check, read live from the monitor.
    const live = yield* detail(monitor.id);
    const overview = yield* send("GET", "/api/overview").pipe(
      Effect.flatMap(bodyOf(Overview))
    );
    const row = overview.monitors.find((item) => item.id === monitor.id);
    const lastCheckedAt = live.status.snapshot?.state.lastCheckedAt ?? 0;
    expect(row?.lastCheckedAt).toBeGreaterThanOrEqual(lastCheckedAt);
    expect(Date.now() - (row?.lastCheckedAt ?? 0)).toBeLessThan(15_000);
    expect(row?.status).toBe("up");
    // The plain list carries only what the Registry knows.
    expect(Object.keys((yield* listed) ?? {})).not.toContain("lastCheckedAt");

    // An edit of the URL is a Registry-visible change: pushed once.
    const failing = `${target}?status=500`;
    const edited = yield* send("PATCH", `/api/monitors/${monitor.id}`, {
      body: { url: failing },
    });
    expect(edited.status).toBe(200);
    const afterEdit = yield* registryCalls;
    expect(callsSince(after, afterEdit, "upsertSummary")).toBe(1);
    expect((yield* listed)?.url).toBe(failing);

    // The confirmed failure is a status change: pushed once. Further
    // failures while down change nothing.
    yield* waitFor(
      "down in the Registry",
      Effect.zip(listed, registryCalls),
      ([item]) => item?.status === "down"
    );
    const down = yield* checksNow;
    yield* waitFor(
      "two more failed checks",
      Effect.zip(checksNow, registryCalls),
      ([count]) => count >= down + 2,
      30_000
    );
    expect(callsSince(afterEdit, yield* registryCalls, "upsertSummary")).toBe(
      1
    );
    yield* send("DELETE", `/api/monitors/${monitor.id}`);
  }),
  { timeout: 120_000 }
);
