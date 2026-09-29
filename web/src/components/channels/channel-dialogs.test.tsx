// The dialogs against a fake server: `fetch` is replaced, so the real
// mutation options and typed client run, and each test reads the exact
// requests (method, path, JSON body) the dialogs sent.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ChannelView } from "../../../../src/domain/channel.ts";
import {
  ChannelCreateInput,
  ChannelPatchInput,
} from "../../../../src/domain/channel.ts";
import {
  AddChannelDialog,
  DeleteChannelDialog,
  EditChannelDialog,
} from "./channel-dialogs.tsx";

const channel: ChannelView = {
  createdAt: 0,
  id: "c1",
  kind: "slack",
  maskedUrl: "https://hooks.slack.com/****abcd",
  name: "On-call",
  updatedAt: 0,
};

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/** An error reply the next request gets instead of success. */
interface ErrorReply {
  readonly status: number;
  readonly tag: string;
  readonly message: string;
}

interface FakeServer {
  failNext: ErrorReply | null;
  /** While set, replies wait for it (a slow server). */
  hold: Deferred.Deferred<true> | null;
  readonly requests: SentRequest[];
}

const server: FakeServer = { failNext: null, hold: null, requests: [] };

const json = (status: number, body: Schema.Json) =>
  Response.json(body, { status });

const channelJson = (): Schema.Json => ({ ...channel });

const fakeFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  server.requests.push({
    body: await request.text(),
    method: request.method,
    path: pathname,
  });
  if (server.hold !== null) {
    await Effect.runPromise(Deferred.await(server.hold));
  }
  const failure = server.failNext;
  server.failNext = null;
  if (failure !== null) {
    return json(failure.status, {
      _tag: failure.tag,
      message: failure.message,
    });
  }
  if (request.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  return json(request.method === "POST" ? 201 : 200, channelJson());
};

const decodeCreate = Schema.decodeUnknownSync(
  Schema.fromJsonString(ChannelCreateInput)
);
const decodePatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(ChannelPatchInput)
);

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  );

const field = (name: string) => screen.getByRole("textbox", { name });

const renderAdd = (devMode = false) => {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  wrap(<AddChannelDialog devMode={devMode} onOpenChange={onOpenChange} open />);
  return onOpenChange;
};

const submitAdd = () =>
  userEvent.click(screen.getByRole("button", { name: "Add channel" }));

const renderEdit = (view: ChannelView = channel) => {
  const onClose = vi.fn<() => void>();
  wrap(<EditChannelDialog channel={view} devMode={false} onClose={onClose} />);
  return onClose;
};

const saveButton = () => screen.getByRole("button", { name: "Save changes" });

describe("channel dialogs", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", fakeFetch);
  });

  beforeEach(() => {
    server.requests.length = 0;
    server.failNext = null;
    server.hold = null;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe(AddChannelDialog, () => {
    it("validates before sending anything", async () => {
      renderAdd();
      await submitAdd();
      expect(screen.getByText("Enter a name.")).toBeTruthy();
      expect(
        screen.getByText("Enter the URL alerts are sent to.")
      ).toBeTruthy();
      expect(server.requests).toStrictEqual([]);
    });

    it("refuses http and localhost outside dev mode", async () => {
      const user = userEvent.setup();
      renderAdd();
      await user.type(field("Name"), "Hooks");
      await user.type(field("URL"), "http://localhost:1337/_dev/webhook");
      await submitAdd();
      expect(screen.getByText("Local hostnames are not allowed.")).toBeTruthy();
      await user.clear(field("URL"));
      await user.type(field("URL"), "http://example.com/hook");
      await submitAdd();
      expect(
        screen.getByText("Alert channel URLs must use https.")
      ).toBeTruthy();
      expect(server.requests).toStrictEqual([]);
    });

    it("posts the trimmed payload and closes", async () => {
      const user = userEvent.setup();
      const onOpenChange = renderAdd();
      await user.type(field("Name"), "  On-call  ");
      await user.type(field("URL"), "https://hooks.slack.com/services/T/B/x");
      await submitAdd();
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(server.requests).toHaveLength(1);
      const [sent] = server.requests;
      expect(sent?.method).toBe("POST");
      expect(sent?.path).toBe("/api/channels");
      expect(decodeCreate(sent?.body)).toStrictEqual({
        kind: "slack",
        name: "On-call",
        url: "https://hooks.slack.com/services/T/B/x",
      });
    });

    it("sends the chosen kind; dev mode allows localhost", async () => {
      const user = userEvent.setup();
      renderAdd(true);
      await user.type(field("Name"), "Sink");
      await user.click(screen.getByRole("combobox", { name: "Kind" }));
      await user.click(await screen.findByRole("option", { name: "Webhook" }));
      await user.type(field("URL"), "http://localhost:1337/_dev/webhook");
      await submitAdd();
      await waitFor(() => expect(server.requests).toHaveLength(1));
      expect(decodeCreate(server.requests[0]?.body)).toStrictEqual({
        kind: "webhook",
        name: "Sink",
        url: "http://localhost:1337/_dev/webhook",
      });
    });

    it("shows the server's URL check (400) on the URL field", async () => {
      const user = userEvent.setup();
      renderAdd();
      await user.type(field("Name"), "X");
      await user.type(field("URL"), "https://example.com/hook");
      server.failNext = {
        message: "url: only http and https URLs are allowed",
        status: 400,
        tag: "BadRequest",
      };
      await submitAdd();
      await expect(
        screen.findByText("Only http and https URLs are allowed.")
      ).resolves.toBeTruthy();
    });
  });

  describe(EditChannelDialog, () => {
    it("shows the masked URL, never an editable current URL", () => {
      renderEdit();
      expect(screen.getByText(channel.maskedUrl)).toBeTruthy();
      expect(field("Replace URL (optional)")).toHaveProperty("value", "");
      expect(saveButton()).toHaveProperty("disabled", true);
    });

    it("patches only the new name", async () => {
      const user = userEvent.setup();
      const onClose = renderEdit();
      await user.clear(field("Name"));
      await user.type(field("Name"), "Pager");
      await user.click(saveButton());
      await waitFor(() => expect(onClose).toHaveBeenCalledWith());
      const [sent] = server.requests;
      expect(sent?.method).toBe("PATCH");
      expect(sent?.path).toBe("/api/channels/c1");
      expect(decodePatch(sent?.body)).toStrictEqual({ name: "Pager" });
    });

    it("replaces the URL after checking it", async () => {
      const user = userEvent.setup();
      renderEdit();
      const replace = field("Replace URL (optional)");
      await user.type(replace, "https://10.1.2.3/h");
      await user.click(saveButton());
      expect(
        screen.getByText("Private and reserved IP addresses are not allowed.")
      ).toBeTruthy();
      expect(server.requests).toStrictEqual([]);
      await user.clear(replace);
      await user.type(replace, "https://hooks.slack.com/services/new");
      await user.click(saveButton());
      await waitFor(() => expect(server.requests).toHaveLength(1));
      expect(decodePatch(server.requests[0]?.body)).toStrictEqual({
        url: "https://hooks.slack.com/services/new",
      });
    });
  });

  describe(DeleteChannelDialog, () => {
    it("warns about monitors, then deletes and closes", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn<() => void>();
      wrap(<DeleteChannelDialog channel={channel} onClose={onClose} />);
      expect(screen.getByRole("alertdialog").textContent).toMatch(
        /Monitors that list this channel will stop alerting through it/u
      );
      await user.click(screen.getByRole("button", { name: "Delete channel" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledWith());
      expect(server.requests).toStrictEqual([
        { body: "", method: "DELETE", path: "/api/channels/c1" },
      ]);
    });

    it("stays open while deleting, so a failure is seen", async () => {
      const user = userEvent.setup();
      const onClose = vi.fn<() => void>();
      const hold = Deferred.makeUnsafe<true>();
      server.hold = hold;
      wrap(<DeleteChannelDialog channel={channel} onClose={onClose} />);
      await user.click(screen.getByRole("button", { name: "Delete channel" }));
      await waitFor(() => expect(server.requests).toHaveLength(1));
      expect(screen.getByRole("button", { name: "Deleting…" })).toBeDefined();

      // Escape and a click outside do not dismiss it mid-request.
      await user.keyboard("{Escape}");
      await user.click(document.body);
      expect(onClose).not.toHaveBeenCalled();

      server.failNext = {
        message: "channel c1 no longer exists",
        status: 404,
        tag: "NotFound",
      };
      Deferred.doneUnsafe(hold, Exit.succeed(true));
      await waitFor(() =>
        expect(screen.getByRole("alertdialog").textContent).toMatch(
          /channel c1 no longer exists/u
        )
      );
      expect(onClose).not.toHaveBeenCalled();

      // Once settled, it can be dismissed again.
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledWith();
    });
  });
});
