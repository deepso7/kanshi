import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  backoffMs,
  DeliveryResult,
  maxAttempts,
} from "../../src/alerts/delivery.ts";
import type { Notification, OutboxEntry } from "../../src/domain/alert.ts";
import type { MonitorConfig } from "../../src/domain/monitor.ts";
import { initialState, nextAlarmAt } from "../../src/monitor/cycle.ts";
import {
  afterAttempt,
  deferred,
  deliverDue,
  deliveryGroups,
  dueNotifications,
  dueOutbox,
  notificationFailed,
  notificationsDueAt,
  notificationWaits,
  outboxDecision,
  OutboxDecision,
  outboxDueAt,
  skipped,
} from "../../src/monitor/outbox.ts";

const t0 = 1_000_000;

const notification = (
  overrides: Partial<Notification> & Pick<Notification, "event">
): Notification => ({
  attempts: 0,
  createdAt: t0,
  incidentId: "inc1",
  lastError: null,
  nextAttemptAt: t0,
  resolved: false,
  ...overrides,
});

const row = (
  overrides: Partial<OutboxEntry> & Pick<OutboxEntry, "event">
): OutboxEntry => ({
  attempts: 0,
  channelId: "c1",
  combined: false,
  createdAt: t0,
  incidentId: "inc1",
  lastError: null,
  nextAttemptAt: t0,
  state: "pending",
  updatedAt: t0,
  ...overrides,
});

const open = { resolution: null, resolvedAt: null };
const recovered = { resolution: "recovered" as const, resolvedAt: t0 + 60_000 };

describe("notifications", () => {
  it("an up waits for its incident's unresolved down", () => {
    const down = notification({ event: "down" });
    const up = notification({ createdAt: t0 + 10, event: "up" });
    assert.isTrue(notificationWaits(up, [down, up]));
    assert.isFalse(notificationWaits(up, [{ ...down, resolved: true }, up]));
    assert.isFalse(notificationWaits(down, [down, up]));
    // Another incident's down does not block it.
    assert.isFalse(
      notificationWaits(up, [{ ...down, incidentId: "other" }, up])
    );
  });

  it("works on due notifications, down before up", () => {
    const up = notification({ event: "up" });
    const down = notification({ event: "down" });
    const later = notification({
      event: "down",
      incidentId: "inc2",
      nextAttemptAt: t0 + 5000,
    });
    assert.deepStrictEqual(dueNotifications([up, later, down], t0), [down, up]);
    assert.deepStrictEqual(
      dueNotifications([{ ...down, resolved: true }], t0),
      []
    );
  });

  it("feeds the earliest non-waiting retry into the alarm", () => {
    const down = notification({ event: "down", nextAttemptAt: t0 + 30_000 });
    const up = notification({ event: "up", nextAttemptAt: t0 });
    // The up is due earlier but waits for the down.
    assert.strictEqual(notificationsDueAt([down, up]), t0 + 30_000);
    assert.strictEqual(
      notificationsDueAt([{ ...down, resolved: true }, up]),
      t0
    );
    assert.isNull(notificationsDueAt([{ ...down, resolved: true }]));
  });

  it("retries resolution with backoff while the Registry is unreachable", () => {
    const failed = notificationFailed(
      notification({ event: "down" }),
      "registry: down",
      t0
    );
    assert.strictEqual(failed.attempts, 1);
    assert.strictEqual(failed.nextAttemptAt, t0 + 30_000);
    assert.strictEqual(failed.lastError, "registry: down");
    assert.isFalse(failed.resolved);
    const again = notificationFailed(failed, "registry: down", t0 + 30_000);
    assert.strictEqual(again.nextAttemptAt, t0 + 30_000 + 60_000);
  });
});

describe("outbox ordering", () => {
  it("sends down while open and down-recovered once resolved", () => {
    const down = row({ event: "down" });
    assert.deepStrictEqual(
      outboxDecision(down, down, open),
      OutboxDecision.Send({ message: "Down" })
    );
    assert.deepStrictEqual(
      outboxDecision(down, down, recovered),
      OutboxDecision.Send({ message: "DownRecovered" })
    );
  });

  it("skips a down whose incident was closed by disabling or deleting", () => {
    const down = row({ event: "down" });
    for (const resolution of ["disabled", "deleted"] as const) {
      const decision = outboxDecision(down, down, {
        resolution,
        resolvedAt: t0,
      });
      assert.strictEqual(decision._tag, "Skip", resolution);
    }
    assert.strictEqual(outboxDecision(down, down, null)._tag, "Skip");
  });

  it("an up waits for its down, and is sent only after it was delivered", () => {
    const up = row({ event: "up" });
    const down = row({ event: "down" });
    assert.deepStrictEqual(
      outboxDecision(up, down, recovered),
      OutboxDecision.Wait()
    );
    assert.deepStrictEqual(
      outboxDecision(up, { ...down, state: "delivered" }, recovered),
      OutboxDecision.Send({ message: "Recovered" })
    );
  });

  it("skips an up whose down failed, was skipped, is missing or already said recovered", () => {
    const up = row({ event: "up" });
    const down = row({ event: "down" });
    for (const state of ["failed", "skipped"] as const) {
      assert.strictEqual(
        outboxDecision(up, { ...down, state }, recovered)._tag,
        "Skip",
        state
      );
    }
    assert.strictEqual(outboxDecision(up, null, recovered)._tag, "Skip");
    assert.strictEqual(
      outboxDecision(
        up,
        { ...down, combined: true, state: "delivered" },
        recovered
      )._tag,
      "Skip"
    );
  });

  it("leaves rows that are no longer pending alone", () => {
    for (const state of ["delivered", "failed", "skipped"] as const) {
      assert.deepStrictEqual(
        outboxDecision(row({ event: "down", state }), null, open),
        OutboxDecision.Done()
      );
    }
  });

  it("orders due rows oldest first, down before up", () => {
    const upC1 = row({ event: "up" });
    const downC2 = row({ channelId: "c2", event: "down" });
    const downC1 = row({ event: "down" });
    const newer = row({ createdAt: t0 - 1, event: "down", incidentId: "old" });
    const notYet = row({
      channelId: "c3",
      event: "down",
      nextAttemptAt: t0 + 1,
    });
    const done = row({ channelId: "c4", event: "down", state: "delivered" });
    assert.deepStrictEqual(
      dueOutbox([upC1, downC2, notYet, done, downC1, newer], t0),
      [newer, downC1, downC2, upC1]
    );
  });

  it("feeds the earliest non-waiting pending attempt into the alarm", () => {
    const down = row({ event: "down", nextAttemptAt: t0 + 60_000 });
    const up = row({ event: "up", nextAttemptAt: t0 });
    assert.strictEqual(outboxDueAt([down, up]), t0 + 60_000);
    assert.strictEqual(outboxDueAt([{ ...down, state: "delivered" }, up]), t0);
    // A failed down: the up is due now (to be skipped).
    assert.strictEqual(outboxDueAt([{ ...down, state: "failed" }, up]), t0);
    assert.isNull(
      outboxDueAt([
        { ...down, state: "delivered" },
        { ...up, state: "delivered" },
      ])
    );
    // Per channel: another channel's pending down does not block this up.
    assert.strictEqual(
      outboxDueAt([
        { ...down, channelId: "c2" },
        { ...down, state: "delivered" },
        up,
      ]),
      t0
    );
  });
});

describe("delivery attempts", () => {
  const down = row({ event: "down" });

  it("marks delivered and records whether recovery was included", () => {
    const delivered = afterAttempt(
      down,
      DeliveryResult.Delivered({ status: 200 }),
      true,
      t0 + 5
    );
    assert.strictEqual(delivered.state, "delivered");
    assert.strictEqual(delivered.attempts, 1);
    assert.isTrue(delivered.combined);
    assert.strictEqual(delivered.updatedAt, t0 + 5);
  });

  it("fails permanently on a permanent error", () => {
    const failed = afterAttempt(
      down,
      DeliveryResult.Failed({
        error: "HTTP 404",
        permanent: true,
        status: 404,
      }),
      false,
      t0
    );
    assert.strictEqual(failed.state, "failed");
    assert.strictEqual(failed.lastError, "HTTP 404");
  });

  it("retries with backoff and fails after the 8th attempt", () => {
    const retry = DeliveryResult.Failed({
      error: "HTTP 500",
      permanent: false,
      status: 500,
    });
    let current = down;
    let now = t0;
    for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
      current = afterAttempt(current, retry, false, now);
      assert.strictEqual(current.state, "pending");
      assert.strictEqual(current.attempts, attempt);
      assert.strictEqual(current.nextAttemptAt, now + backoffMs(attempt));
      now = current.nextAttemptAt;
    }
    const last = afterAttempt(current, retry, false, now);
    assert.strictEqual(last.state, "failed");
    assert.strictEqual(last.attempts, maxAttempts);
  });

  it("skips and defers without spending an attempt", () => {
    const skip = skipped(down, "down alert failed", t0);
    assert.strictEqual(skip.state, "skipped");
    assert.strictEqual(skip.attempts, 0);
    const later = deferred({ ...down, attempts: 3 }, "registry: down", t0);
    assert.strictEqual(later.state, "pending");
    assert.strictEqual(later.attempts, 3);
    assert.strictEqual(later.nextAttemptAt, t0 + backoffMs(3));
    assert.strictEqual(deferred(down, "x", t0).nextAttemptAt, t0 + 30_000);
  });
});

describe("alarm computation with alert work", () => {
  const config: MonitorConfig = {
    bodyContains: null,
    channels: "all",
    createdAt: t0,
    enabled: true,
    expectedStatus: "2xx",
    failureThreshold: 1,
    generation: 0,
    id: "m1",
    intervalSeconds: 60,
    key: "m1",
    managed: false,
    method: "GET",
    name: "Site",
    successThreshold: 1,
    timeoutMs: 10_000,
    updatedAt: t0,
    url: "https://example.com/",
  };
  const state = {
    ...initialState(t0),
    nextCheckAt: t0 + 60_000,
    nextMaintenanceAt: null,
  };

  it("wakes for the earliest notification retry or outbox attempt", () => {
    const outbox = [row({ event: "down", nextAttemptAt: t0 + 30_000 })];
    const notifications = [
      notification({ event: "down", nextAttemptAt: t0 + 45_000 }),
    ];
    assert.strictEqual(
      nextAlarmAt(config, state, [
        notificationsDueAt(notifications),
        outboxDueAt(outbox),
      ]),
      t0 + 30_000
    );
    assert.strictEqual(
      nextAlarmAt(config, state, [notificationsDueAt(notifications), null]),
      t0 + 45_000
    );
  });

  it("keeps delivering alerts while the monitor is disabled", () => {
    const pending = row({ event: "down", nextAttemptAt: t0 + 30_000 });
    const outbox = [pending];
    assert.strictEqual(
      nextAlarmAt({ ...config, enabled: false }, state, [outboxDueAt(outbox)]),
      t0 + 30_000
    );
    assert.isNull(
      nextAlarmAt({ ...config, enabled: false }, state, [
        outboxDueAt([{ ...pending, state: "delivered" }]),
        notificationsDueAt([]),
      ])
    );
  });

  it("does not spin on an up that waits for its down", () => {
    const outbox = [
      row({ event: "down", nextAttemptAt: t0 + 120_000 }),
      row({ event: "up", nextAttemptAt: t0 }),
    ];
    assert.strictEqual(
      nextAlarmAt(config, state, [outboxDueAt(outbox)]),
      t0 + 60_000
    );
  });
});

const label = (entry: OutboxEntry) => `${entry.incidentId}@${entry.channelId}`;

describe("delivery per alarm run", () => {
  it("groups rows per channel across incidents, keeping their order", () => {
    const down1 = row({ event: "down" });
    const down2 = row({ channelId: "c2", event: "down" });
    const up1 = row({ createdAt: t0 + 5, event: "up" });
    const other = row({
      createdAt: t0 + 10,
      event: "down",
      incidentId: "inc2",
    });
    assert.deepStrictEqual(deliveryGroups([down1, down2, up1, other]), [
      [down1, up1, other],
      [down2],
    ]);
  });

  it.effect(
    "sends one channel's alerts in incident order, other channels alongside",
    () =>
      Effect.gen(function* channelOrderTest() {
        // inc1 already recovered ("was down, recovered"); inc2 is newer and
        // open ("is down"). Both are due for c1 in the same run; inc1's
        // send is slow, so running them side by side would land inc2 first.
        const older = row({ event: "down", incidentId: "inc1" });
        const newer = row({
          createdAt: t0 + 60_000,
          event: "down",
          incidentId: "inc2",
        });
        const elsewhere = row({
          channelId: "c2",
          createdAt: t0 + 60_000,
          event: "down",
          incidentId: "inc2",
        });
        const slowness = new Map([
          [older, "10 seconds"],
          [newer, "1 second"],
          [elsewhere, "1 second"],
        ] as const);
        const events: string[] = [];
        const fiber = yield* deliverDue(
          dueOutbox([newer, elsewhere, older], t0 + 60_000),
          (entry) =>
            Effect.gen(function* timedAttempt() {
              events.push(`start ${label(entry)}`);
              yield* Effect.sleep(slowness.get(entry) ?? "1 second");
              events.push(`done ${label(entry)}`);
            }),
          { budgetMs: 60_000, concurrency: 5, rowsPerRun: 25 }
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        const attempted = yield* Fiber.join(fiber);
        assert.deepStrictEqual(events, [
          "start inc1@c1",
          "start inc2@c2",
          "done inc2@c2",
          "done inc1@c1",
          "start inc2@c1",
          "done inc2@c1",
        ]);
        assert.deepStrictEqual(attempted, [older, elsewhere, newer]);
      })
  );

  it.effect(
    "bounds concurrency and stops starting attempts after the budget",
    () =>
      Effect.gen(function* budgetTest() {
        const rows = Array.from({ length: 12 }, (_, index) =>
          row({
            channelId: `c${String(index).padStart(2, "0")}`,
            event: "down",
          })
        );
        let inFlight = 0;
        let maxInFlight = 0;
        const fiber = yield* deliverDue(
          rows,
          () =>
            Effect.gen(function* slowAttempt() {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              yield* Effect.sleep("10 seconds");
              inFlight -= 1;
            }),
          { budgetMs: 15_000, concurrency: 5, rowsPerRun: 25 }
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        const attempted = yield* Fiber.join(fiber);
        // Five start at 0s, five at 10s; at 20s the budget is spent.
        assert.strictEqual(maxInFlight, 5);
        assert.deepStrictEqual(attempted, rows.slice(0, 10));
      })
  );

  it.effect("runs a group's rows in order and caps rows per run", () =>
    Effect.gen(function* orderTest() {
      const down = row({ event: "down" });
      const up = row({ createdAt: t0 + 5, event: "up" });
      const seen: OutboxEntry[] = [];
      const attempted = yield* deliverDue(
        [down, up, row({ channelId: "c2", event: "down" })],
        (entry) => Effect.sync(() => seen.push(entry)).pipe(Effect.asVoid),
        { budgetMs: 1000, concurrency: 5, rowsPerRun: 2 }
      );
      assert.deepStrictEqual(attempted, [down, up]);
      assert.deepStrictEqual(seen, [down, up]);
    })
  );
});
