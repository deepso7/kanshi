import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { themeStorageKey } from "../theme/preference.ts";
import { ThemeProvider } from "../theme/theme-provider.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

const renderToggle = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  );

const pressed = () =>
  screen
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.getAttribute("aria-label"));

describe(ThemeToggle, () => {
  it("follows the system when nothing is stored", () => {
    renderToggle();
    expect(pressed()).toStrictEqual(["System theme"]);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("stores the choice and applies it to <html>", async () => {
    const user = userEvent.setup();
    renderToggle();
    const lightClasses = document.documentElement.className;

    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    expect(localStorage.getItem(themeStorageKey)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.className).not.toBe(lightClasses);
    expect(pressed()).toStrictEqual(["Dark theme"]);
  });

  it("forgets the choice when going back to the system", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    await user.click(screen.getByRole("button", { name: "System theme" }));
    expect(localStorage.getItem(themeStorageKey)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("restores the stored choice on the next load", async () => {
    const user = userEvent.setup();
    const first = renderToggle();
    await user.click(screen.getByRole("button", { name: "Dark theme" }));
    first.unmount();

    renderToggle();
    expect(pressed()).toStrictEqual(["Dark theme"]);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("keeps the choice when the pressed option is pressed again", async () => {
    const user = userEvent.setup();
    renderToggle();
    await user.click(screen.getByRole("button", { name: "Light theme" }));
    await user.click(screen.getByRole("button", { name: "Light theme" }));
    expect(pressed()).toStrictEqual(["Light theme"]);
    expect(localStorage.getItem(themeStorageKey)).toBe("light");
  });
});
