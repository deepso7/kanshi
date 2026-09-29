import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { MonitorResponse } from "../../../src/api/spec.ts";
import { BadRequest, Conflict } from "../../../src/api/spec.ts";
import type { ChannelView } from "../../../src/domain/channel.ts";
import type {
  MonitorCreateInput,
  MonitorPatchInput,
} from "../../../src/domain/monitor-input.ts";
import {
  defaultFormValues,
  formValuesOf,
  patchPayload,
  serverFieldError,
  validateMonitorForm,
} from "./monitor-form-model.ts";
import { MonitorForm } from "./monitor-form.tsx";

const channel = (id: string, name: string): ChannelView => ({
  createdAt: 0,
  id,
  key: id,
  kind: "slack",
  managed: false,
  maskedUrl: `https://hooks.example.com/****${id}`,
  name,
  updatedAt: 0,
  urlHash: id,
});

const channels = [channel("c1", "Ops Slack"), channel("c2", "Pager")];

const monitor: MonitorResponse = {
  bodyContains: null,
  channels: ["c1"],
  createdAt: 1_700_000_000_000,
  enabled: true,
  expectedStatus: "2xx",
  failureThreshold: 2,
  generation: 0,
  id: "m1",
  intervalSeconds: 60,
  key: "api",
  managed: false,
  method: "GET",
  name: "API",
  notChecked: false,
  public: false,
  state: {
    confirmCounted: false,
    failureStreak: 0,
    inflight: null,
    lastCheckedAt: null,
    lastResult: null,
    manualRequestedAt: null,
    nextCheckAt: 0,
    nextCheckKind: "scheduled",
    nextMaintenanceAt: null,
    nextSlotAt: 0,
    openIncidentId: null,
    rolledUpThrough: null,
    scheduleResetAt: 0,
    status: "up",
    successStreak: 0,
    summaryRevision: 0,
  },
  successThreshold: 1,
  timeoutMs: 10_000,
  updatedAt: 1_700_000_000_000,
  url: "https://api.example.com/health",
};

const prodRules = { devMode: false, minIntervalSeconds: 30 };

const setup = (existing: MonitorResponse | null = null) => {
  const onCreate = vi.fn<(payload: MonitorCreateInput) => Promise<void>>(() =>
    Promise.resolve()
  );
  const onUpdate = vi.fn<(patch: MonitorPatchInput) => Promise<void>>(() =>
    Promise.resolve()
  );
  const user = userEvent.setup();
  render(
    <MonitorForm
      cancel={<a href="/">Cancel</a>}
      channels={channels}
      channelsLink={<a href="/channels">Add a channel</a>}
      monitor={existing}
      onCreate={onCreate}
      onUpdate={onUpdate}
      rules={prodRules}
    />
  );
  return { onCreate, onUpdate, user };
};

const field = (label: string) => screen.getByLabelText(label);

const urlError = (url: string, devMode = false) =>
  validateMonitorForm(
    { ...defaultFormValues, name: "x", url },
    { devMode, minIntervalSeconds: 5 }
  ).url;

describe(validateMonitorForm, () => {
  it("accepts the defaults with a name and a URL", () => {
    expect(
      validateMonitorForm(
        { ...defaultFormValues, name: "API", url: "example.com" },
        prodRules
      )
    ).toStrictEqual({});
  });

  it("mirrors the server's URL rules", () => {
    expect(urlError("")).toBe("Enter the URL to check.");
    expect(urlError("ftp://example.com")).toBe(
      "Only http and https URLs can be checked."
    );
    expect(urlError("https://user:pw@example.com")).toBe(
      "Remove the username and password from the URL."
    );
    expect(urlError("http://10.0.0.1/")).toBe(
      "Private and reserved IP addresses are not allowed."
    );
    expect(urlError("example.com/health")).toBeUndefined();
  });

  it("allows loopback targets in dev mode only", () => {
    expect(urlError("http://localhost:1337/")).toMatch(/^Local hostnames/u);
    expect(urlError("http://localhost:1337/", true)).toBeUndefined();
  });

  it("checks HEAD with a keyword, thresholds, timeout, status and interval", () => {
    const errors = validateMonitorForm(
      {
        ...defaultFormValues,
        bodyContains: "ok",
        expectedStatus: "2xx,abc",
        failureThreshold: "11",
        intervalSeconds: "10",
        key: "-bad",
        method: "HEAD",
        name: " ",
        successThreshold: "1.5",
        timeoutSeconds: "31",
        url: "example.com",
      },
      prodRules
    );
    expect(errors).toStrictEqual({
      bodyContains:
        "Only works with GET: a HEAD response has no body. Clear it or switch to GET.",
      expectedStatus:
        "Use codes like 200 or classes like 2xx, separated by commas.",
      failureThreshold: "At most 10.",
      intervalSeconds: "At least 30 seconds.",
      key: "Up to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.",
      name: "Enter a name.",
      successThreshold: "Use a whole number.",
      timeoutSeconds: "Between 1 and 30 seconds.",
    });
  });
});

describe(patchPayload, () => {
  it("is empty when nothing changed, even when retyped", () => {
    const initial = formValuesOf(monitor);
    expect(
      patchPayload(initial, { ...initial, name: " API " }, channels)
    ).toStrictEqual({});
  });

  it("ignores the order of selected channels", () => {
    const initial = { ...formValuesOf(monitor), channels: ["c1", "c2"] };
    expect(
      patchPayload(initial, { ...initial, channels: ["c2", "c1"] }, channels)
    ).toStrictEqual({});
  });
});

describe(serverFieldError, () => {
  it("maps the server's field messages", () => {
    expect(
      serverFieldError(
        new BadRequest({ message: "url: local hostnames are not allowed" })
      )
    ).toStrictEqual({
      field: "url",
      message: "Local hostnames are not allowed.",
    });
    expect(
      serverFieldError(
        new BadRequest({ message: "intervalSeconds must be at least 30" })
      )
    ).toStrictEqual({
      field: "intervalSeconds",
      message: "At least 30 seconds.",
    });
    expect(
      serverFieldError(
        new Conflict({ message: 'a monitor with key "api" already exists' })
      )
    ).toStrictEqual({
      field: "key",
      message: "Another monitor already uses this key.",
    });
  });

  it("leaves other errors to the form", () => {
    expect(
      serverFieldError(new Conflict({ message: "monitor quota of 5 reached" }))
    ).toBeNull();
    expect(serverFieldError(new Error("offline"))).toBeNull();
  });
});

describe(MonitorForm, () => {
  it("shows every client-side error on submit and sends nothing", async () => {
    const { onCreate, user } = setup();
    await user.type(field("URL"), "ftp://example.com");
    await user.type(field("Body contains"), "ok");
    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a name.")).toBeDefined();
    expect(
      screen.getByText("Only http and https URLs can be checked.")
    ).toBeDefined();
  });

  it("flags a keyword with HEAD", async () => {
    const { onCreate, user } = setup();
    await user.type(field("Name"), "API");
    await user.type(field("URL"), "example.com");
    await user.type(field("Body contains"), "ok");
    await user.click(field("Method"));
    await user.click(await screen.findByRole("option", { name: "HEAD" }));
    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/a HEAD response has no body/u)).toBeDefined();
  });

  it("creates with every field", async () => {
    const { onCreate, user } = setup();
    await user.type(field("Name"), "  API  ");
    await user.type(field("URL"), "example.com/health");
    await user.clear(field("Expected status"));
    await user.type(field("Expected status"), "200,204");
    await user.type(field("Body contains"), "ok");
    await user.click(screen.getByRole("button", { name: "5m" }));
    await user.clear(field("Timeout"));
    await user.type(field("Timeout"), "2.5");
    await user.clear(field("Down after"));
    await user.type(field("Down after"), "3");
    await user.click(screen.getByRole("radio", { name: /Selected channels/u }));
    await user.click(screen.getByRole("checkbox", { name: /Pager/u }));
    await user.click(screen.getByRole("switch", { name: "Public" }));
    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate.mock.calls[0]?.[0]).toStrictEqual({
      bodyContains: "ok",
      channels: ["c2"],
      enabled: true,
      expectedStatus: "200,204",
      failureThreshold: 3,
      intervalSeconds: 300,
      method: "GET",
      name: "API",
      public: true,
      successThreshold: 1,
      timeoutMs: 2500,
      url: "example.com/health",
    });
  });

  it("patches only the changed fields", async () => {
    const { onUpdate, user } = setup(monitor);
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toHaveProperty("disabled", true);

    await user.clear(field("Name"));
    await user.type(field("Name"), "Public API");
    await user.click(screen.getByRole("checkbox", { name: /Pager/u }));
    await user.click(screen.getByRole("switch", { name: "Checking" }));
    expect(screen.getByText("3 unsaved changes.")).toBeDefined();
    await user.click(save);

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]?.[0]).toStrictEqual({
      channels: ["c1", "c2"],
      enabled: false,
      name: "Public API",
    });
  });

  it("switches to all channels with a one-field patch", async () => {
    const { onUpdate, user } = setup(monitor);
    await user.click(screen.getByRole("radio", { name: /All channels/u }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onUpdate.mock.calls[0]?.[0]).toStrictEqual({ channels: "all" });
  });

  it("shows a server error on its field", async () => {
    const { onCreate, user } = setup();
    onCreate.mockRejectedValueOnce(
      new Conflict({ message: 'a monitor with key "api" already exists' })
    );
    await user.type(field("Name"), "API");
    await user.type(field("URL"), "example.com");
    await user.type(field("Key"), "api");
    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    const key = field("Key");
    expect(key.getAttribute("aria-invalid")).toBe("true");
    const message = screen.getByText("Another monitor already uses this key.");
    expect(key.getAttribute("aria-describedby")).toContain(message.id);
  });

  it("shows other server errors above the form", async () => {
    const { onCreate, user } = setup();
    onCreate.mockRejectedValueOnce(
      new Conflict({ message: "monitor quota of 5 reached" })
    );
    await user.type(field("Name"), "API");
    await user.type(field("URL"), "example.com");
    await user.click(screen.getByRole("button", { name: "Create monitor" }));

    expect(screen.getByRole("alert").textContent).toContain(
      "monitor quota of 5 reached"
    );
  });
});
