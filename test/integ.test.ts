import { expect } from "bun:test";

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import Stack from "./alchemy.run.ts";

const apiToken = "integration-api-token";
const testToken = "integration";

const { afterAll, beforeAll, beforeEach, deploy, destroy, test } = Test.make({
  providers: Cloudflare.providers(),
  stage: "test",
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

const jsonRequest = (
  method: "PATCH" | "POST",
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
) => {
  const request =
    method === "POST"
      ? HttpClientRequest.post(url)
      : HttpClientRequest.patch(url);
  return request.pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.bodyJsonUnsafe(body)
  );
};

const apiRequest = (method: "PATCH" | "POST", url: string, body: unknown) =>
  jsonRequest(method, url, body, {
    authorization: `Bearer ${apiToken}`,
  });

const harnessRequest = (
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {}
) => {
  let request = HttpClientRequest.get(url);
  if (method === "POST") {
    request =
      body === undefined
        ? HttpClientRequest.post(url)
        : jsonRequest("POST", url, body);
  }
  return request.pipe(
    HttpClientRequest.setHeaders({
      ...headers,
      "x-kanshi-test": testToken,
    })
  );
};

const execute = Test.executeWhenReady;

beforeEach(
  Effect.gen(function* ResetIntegrationState() {
    const { harnessUrl } = yield* stack;
    const response = yield* execute(
      harnessRequest("POST", `${harnessUrl}/reset`)
    );
    expect(response.status).toBe(204);
  }),
  { timeout: 120_000 }
);

interface MonitorResponse {
  readonly enabled: boolean;
  readonly failureStreak: number;
  readonly id: string;
  readonly nextCheckAt: number;
  readonly revision: number;
  readonly status: "down" | "unknown" | "up";
}

interface HarnessState {
  readonly deliveries: readonly {
    readonly attempts: number;
    readonly last_error: string | null;
    readonly state: string;
  }[];
  readonly incidents: readonly {
    readonly resolution: string | null;
    readonly resolved_at: number | null;
  }[];
  readonly monitor: {
    readonly enabled: number;
    readonly failure_streak: number;
    readonly next_check_at: number;
    readonly revision: number;
    readonly status: string;
  };
}

const createMonitor = Effect.fn("Test.createMonitor")(function* CreateMonitor(
  apiUrl: string,
  probeUrl: string,
  failureThreshold = 1
) {
  const response = yield* execute(
    apiRequest("POST", `${apiUrl}/monitors`, {
      failureThreshold,
      name: "Integration target",
      timeoutMs: 5000,
      url: probeUrl,
    })
  );
  expect(response.status).toBe(200);
  return (yield* response.json) as unknown as MonitorResponse;
});

const tick = (harnessUrl: string, webhookSinkUrl: string, probeDelayMs = 0) =>
  execute(
    harnessRequest("POST", `${harnessUrl}/tick`, undefined, {
      "x-harness-origin": harnessUrl,
      "x-probe-delay-ms": String(probeDelayMs),
      "x-webhook-origin": webhookSinkUrl,
    })
  );

const readState = Effect.fn("Test.readState")(function* ReadState(
  harnessUrl: string,
  monitorId: string
) {
  const response = yield* execute(
    harnessRequest("GET", `${harnessUrl}/state/${monitorId}`)
  );
  expect(response.status).toBe(200);
  return (yield* response.json) as unknown as HarnessState;
});

test(
  "requires bearer auth and rejects private probe targets",
  Effect.gen(function* AuthAndSsrfTest() {
    const { apiUrl } = yield* stack;

    const unauthorized = yield* execute(
      HttpClientRequest.get(`${apiUrl}/monitors`)
    );
    expect(unauthorized.status).toBe(401);

    const blocked = yield* execute(
      apiRequest("POST", `${apiUrl}/monitors`, {
        name: "Private target",
        url: "https://127.0.0.1/",
      })
    );
    expect(blocked.status).toBe(400);
  }),
  { timeout: 120_000 }
);

test(
  "opens an incident only after the failure threshold",
  Effect.gen(function* FailureThresholdTest() {
    const { apiUrl, harnessUrl, targetUrl, webhookSinkUrl } = yield* stack;
    const monitor = yield* createMonitor(
      apiUrl,
      `${targetUrl}/target?status=500`,
      2
    );

    expect((yield* tick(harnessUrl, webhookSinkUrl)).status).toBe(204);
    const first = yield* readState(harnessUrl, monitor.id);
    expect(first.monitor.status).toBe("unknown");
    expect(first.monitor.failure_streak).toBe(1);
    expect(first.incidents).toHaveLength(0);

    yield* execute(harnessRequest("POST", `${harnessUrl}/due/${monitor.id}`));
    expect((yield* tick(harnessUrl, webhookSinkUrl)).status).toBe(204);
    const second = yield* readState(harnessUrl, monitor.id);
    expect(second.monitor.status).toBe("down");
    expect(second.monitor.failure_streak).toBe(2);
    expect(second.incidents).toHaveLength(1);
    expect(second.incidents[0]?.resolved_at).toBeNull();
  }),
  { timeout: 120_000 }
);

test(
  "disabling a down monitor closes its incident and re-enable can open another",
  Effect.gen(function* DisableWhileDownTest() {
    const { apiUrl, harnessUrl, targetUrl, webhookSinkUrl } = yield* stack;
    const monitor = yield* createMonitor(
      apiUrl,
      `${targetUrl}/target?status=500`
    );
    yield* tick(harnessUrl, webhookSinkUrl);

    const disabledResponse = yield* execute(
      apiRequest("PATCH", `${apiUrl}/monitors/${monitor.id}`, {
        enabled: false,
      })
    );
    expect(disabledResponse.status).toBe(200);
    const disabled =
      (yield* disabledResponse.json) as unknown as MonitorResponse;
    expect(disabled.enabled).toBe(false);
    expect(disabled.status).toBe("unknown");

    const closed = yield* readState(harnessUrl, monitor.id);
    expect(closed.incidents).toHaveLength(1);
    expect(closed.incidents[0]?.resolution).toBe("disabled");
    expect(closed.incidents[0]?.resolved_at).toBeNumber();

    const enabledResponse = yield* execute(
      apiRequest("PATCH", `${apiUrl}/monitors/${monitor.id}`, {
        enabled: true,
      })
    );
    expect(enabledResponse.status).toBe(200);
    yield* tick(harnessUrl, webhookSinkUrl);

    const reopened = yield* readState(harnessUrl, monitor.id);
    expect(reopened.monitor.status).toBe("down");
    expect(reopened.incidents).toHaveLength(2);
    expect(reopened.incidents[1]?.resolved_at).toBeNull();
  }),
  { timeout: 120_000 }
);

test(
  "discards a probe result after the monitor revision changes",
  Effect.gen(function* StaleRevisionTest() {
    const { apiUrl, harnessUrl, targetUrl, webhookSinkUrl } = yield* stack;
    const monitor = yield* createMonitor(
      apiUrl,
      `${targetUrl}/target?status=500`
    );

    const runningTick = yield* tick(harnessUrl, webhookSinkUrl, 5000).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = yield* readState(harnessUrl, monitor.id);
      if (state.monitor.next_check_at > monitor.nextCheckAt) {
        break;
      }
      yield* Effect.sleep("100 millis");
    }
    const claimed = yield* readState(harnessUrl, monitor.id);
    expect(claimed.monitor.next_check_at).toBeGreaterThan(monitor.nextCheckAt);
    const update = yield* execute(
      harnessRequest("POST", `${harnessUrl}/bump-revision/${monitor.id}`)
    );
    expect(update.status).toBe(204);
    expect((yield* Fiber.join(runningTick)).status).toBe(204);

    const state = yield* readState(harnessUrl, monitor.id);
    expect(state.monitor.revision).toBe(monitor.revision + 1);
    expect(state.monitor.status).toBe("unknown");
    expect(state.monitor.failure_streak).toBe(0);
    expect(state.incidents).toHaveLength(0);
  }),
  { timeout: 120_000 }
);

test(
  "only one concurrent tick reclaims an expired alert lease",
  Effect.gen(function* AlertLeaseTest() {
    const { apiUrl, harnessUrl, targetUrl, webhookSinkUrl } = yield* stack;
    const monitor = yield* createMonitor(apiUrl, `${targetUrl}/target`);
    yield* execute(
      harnessRequest("POST", `${webhookSinkUrl}/configure`, {
        webhookDelayMs: 750,
      })
    );
    yield* execute(
      harnessRequest("POST", `${harnessUrl}/channel/${monitor.id}`, {
        webhookUrl: `${webhookSinkUrl}/webhook`,
      })
    );
    yield* execute(
      harnessRequest("POST", `${harnessUrl}/seed-alert/${monitor.id}`)
    );

    const responses = yield* Effect.all(
      [tick(harnessUrl, webhookSinkUrl), tick(harnessUrl, webhookSinkUrl)],
      {
        concurrency: 2,
      }
    );
    expect(responses.every((response) => response.status === 204)).toBe(true);

    const state = yield* readState(harnessUrl, monitor.id);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]?.attempts).toBe(1);
    expect(state.deliveries[0]?.state).toBe("delivered");

    const eventsResponse = yield* execute(
      harnessRequest("GET", `${webhookSinkUrl}/events`)
    );
    const eventBody = (yield* eventsResponse.json) as {
      readonly events: readonly unknown[];
    };
    expect(eventBody.events).toHaveLength(1);
  }),
  { timeout: 120_000 }
);
