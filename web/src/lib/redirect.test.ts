import { describe, expect, it } from "vitest";

import { isSafeRedirect, redirectTarget } from "./redirect.ts";

describe(isSafeRedirect, () => {
  it("follows paths on this site only", () => {
    for (const path of [
      "/",
      "/manage",
      "/manage/channels",
      "/manage/monitors/abc?tab=checks#x",
    ]) {
      expect(isSafeRedirect(path)).toBeTruthy();
    }
    for (const path of [
      "",
      "channels",
      "//evil.example.com",
      "/\\evil.example.com",
      "https://evil.example.com",
      "/manage/login",
      "/manage/login?redirect=/manage",
    ]) {
      expect(isSafeRedirect(path)).toBeFalsy();
    }
    expect(isSafeRedirect("/manage/loginx")).toBeTruthy();
  });

  it("falls back to the dashboard", () => {
    expect(redirectTarget()).toBe("/manage");
    expect(redirectTarget("//evil.example.com")).toBe("/manage");
    expect(redirectTarget("/manage/channels")).toBe("/manage/channels");
  });
});
