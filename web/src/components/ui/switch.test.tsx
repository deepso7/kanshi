import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./switch.tsx";

describe(Switch, () => {
  it("toggles on click and reports the new state", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    render(<Switch aria-label="Alerts" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole("switch", { name: "Alerts" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.dataset.checked).toBe("");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true, expect.anything());
  });

  it("toggles back off", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn<(checked: boolean) => void>();
    render(
      <Switch
        aria-label="Alerts"
        defaultChecked
        onCheckedChange={onCheckedChange}
      />
    );
    const toggle = screen.getByRole("switch", { name: "Alerts" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(onCheckedChange).toHaveBeenLastCalledWith(false, expect.anything());
  });

  it("toggles from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Alerts" defaultChecked />);
    const toggle = screen.getByRole("switch", { name: "Alerts" });
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("ignores clicks when disabled", async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Alerts" disabled />);
    const toggle = screen.getByRole("switch", { name: "Alerts" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
