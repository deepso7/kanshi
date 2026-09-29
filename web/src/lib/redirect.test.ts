import { describe, expect, it } from "vitest";

import { isSafeRedirect, redirectTarget } from "./redirect.ts";

describe(isSafeRedirect, () => {
  it("follows paths on this site only", () => {
    for (const path of ["/", "/channels", "/monitors/abc?tab=checks#x"]) {
      expect(isSafeRedirect(path)).toBeTruthy();
    }
    for (const path of [
      "",
      "channels",
      "//evil.example.com",
      "/\\evil.example.com",
      "https://evil.example.com",
      "/login",
      "/login?redirect=/",
    ]) {
      expect(isSafeRedirect(path)).toBeFalsy();
    }
    expect(isSafeRedirect("/loginx")).toBeTruthy();
  });

  it("falls back to the dashboard", () => {
    expect(redirectTarget()).toBe("/");
    expect(redirectTarget("//evil.example.com")).toBe("/");
    expect(redirectTarget("/channels")).toBe("/channels");
  });
});
