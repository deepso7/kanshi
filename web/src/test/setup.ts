// Vitest setup for the `web` project (happy-dom): unmount what a test
// rendered and reset what the theme code persists.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});
