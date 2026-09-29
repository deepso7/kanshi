import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import { BadRequest, NotFound } from "../../../../src/api/spec.ts";
import type { ChannelView } from "../../../../src/domain/channel.ts";
import {
  createPayload,
  describeTestResult,
  editPayload,
  serverErrors,
  urlProblem,
} from "./channel-form.ts";

const prod = { devMode: false };
const dev = { devMode: true };

const channel: ChannelView = {
  createdAt: 0,
  id: "c1",
  kind: "slack",
  maskedUrl: "https://hooks.slack.com/****abcd",
  name: "On-call",
  updatedAt: 0,
};

describe(urlProblem, () => {
  it("accepts https and asks for a URL when empty", () => {
    expect(
      urlProblem("https://hooks.slack.com/services/x", prod)
    ).toBeUndefined();
    expect(urlProblem("", prod)).toBe("Enter the URL alerts are sent to.");
  });

  it("refuses http, and localhost outside dev mode", () => {
    expect(urlProblem("http://example.com/hook", prod)).toBe(
      "Alert channel URLs must use https."
    );
    expect(urlProblem("http://localhost:1337/_dev/webhook", prod)).toBe(
      "Local hostnames are not allowed."
    );
  });

  it("allows http://localhost in dev mode, not other http hosts", () => {
    expect(
      urlProblem("http://localhost:1337/_dev/webhook", dev)
    ).toBeUndefined();
    expect(urlProblem("http://example.com/hook", dev)).toBe(
      "Use https (or http://localhost in dev mode)."
    );
  });

  it("uses the server's rules for private addresses and credentials", () => {
    expect(urlProblem("https://10.0.0.1/hook", dev)).toBe(
      "Private and reserved IP addresses are not allowed."
    );
    expect(urlProblem("https://user:pw@example.com/hook", prod)).toBe(
      "URLs must not contain credentials."
    );
  });
});

describe(createPayload, () => {
  it("trims the values", () => {
    const result = createPayload(
      {
        kind: "discord",
        name: "  Team  ",
        url: " https://discord.com/api/webhooks/1/x ",
      },
      prod
    );
    expect(result).toStrictEqual(
      Result.succeed({
        kind: "discord",
        name: "Team",
        url: "https://discord.com/api/webhooks/1/x",
      })
    );
  });

  it("reports every invalid field at once", () => {
    const result = createPayload({ kind: "slack", name: " ", url: "" }, prod);
    expect(result).toStrictEqual(
      Result.fail({
        name: "Enter a name.",
        url: "Enter the URL alerts are sent to.",
      })
    );
  });

  it("limits the name to 200 characters", () => {
    const result = createPayload(
      { kind: "slack", name: "x".repeat(201), url: "https://a.com" },
      prod
    );
    expect(Result.isFailure(result) && result.failure.name).toBe(
      "At most 200 characters."
    );
  });
});

describe(editPayload, () => {
  it("is empty when nothing changed", () => {
    expect(
      editPayload(channel, { kind: "slack", name: " On-call ", url: "" }, prod)
    ).toStrictEqual(Result.succeed({}));
  });

  it("sends only what changed; a new URL replaces the secret", () => {
    expect(
      editPayload(
        channel,
        { kind: "webhook", name: "Pager", url: " https://example.com/h " },
        prod
      )
    ).toStrictEqual(
      Result.succeed({
        kind: "webhook",
        name: "Pager",
        url: "https://example.com/h",
      })
    );
  });

  it("validates a replacement URL and the name", () => {
    const result = editPayload(
      channel,
      { kind: "slack", name: "", url: "http://example.com" },
      prod
    );
    expect(Result.isFailure(result) && result.failure).toStrictEqual({
      name: "Enter a name.",
      url: "Alert channel URLs must use https.",
    });
  });
});

describe(serverErrors, () => {
  it("puts the server's URL check on the URL field", () => {
    expect(
      serverErrors(
        new BadRequest({ message: "url: local hostnames are not allowed" })
      )
    ).toStrictEqual({ url: "Local hostnames are not allowed." });
  });

  it("shows anything else above the form", () => {
    expect(
      serverErrors(new NotFound({ message: "channel c1 not found" }))
    ).toStrictEqual({ form: "channel c1 not found" });
  });
});

describe(describeTestResult, () => {
  it("describes a delivery", () => {
    expect(
      describeTestResult({ delivered: true, error: null, status: 200 })
    ).toStrictEqual({
      delivered: true,
      detail: "Accepted, HTTP 200.",
      title: "Test alert delivered",
    });
  });

  it("describes a failure without repeating the status", () => {
    expect(
      describeTestResult({
        delivered: false,
        error: "HTTP 500: failed",
        status: 500,
      }).detail
    ).toBe("HTTP 500: failed");
    expect(
      describeTestResult({ delivered: false, error: "timeout", status: null })
    ).toStrictEqual({
      delivered: false,
      detail: "timeout",
      title: "Test alert failed",
    });
    expect(
      describeTestResult({ delivered: false, error: "gone", status: 410 })
        .detail
    ).toBe("HTTP 410: gone");
  });
});
