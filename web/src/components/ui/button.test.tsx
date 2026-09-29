import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ButtonVariant } from "./button.tsx";
import { Button, buttonStyles } from "./button.tsx";

const variants: readonly ButtonVariant[] = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
];

describe(Button, () => {
  it("renders every variant as a button with its own classes", () => {
    render(
      <>
        {variants.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>
    );
    const classes = variants.map((variant) => {
      const button = screen.getByRole("button", { name: variant });
      expect(button.getAttribute("type")).toBe("button");
      return button.className;
    });
    expect(new Set(classes).size).toBe(variants.length);
  });

  it("gives each size its own classes", () => {
    render(
      <>
        <Button size="sm">sm</Button>
        <Button size="lg">lg</Button>
        <Button aria-label="icon" size="icon">
          +
        </Button>
      </>
    );
    const sm = screen.getByRole("button", { name: "sm" }).className;
    const lg = screen.getByRole("button", { name: "lg" }).className;
    const icon = screen.getByRole("button", { name: "icon" }).className;
    expect(new Set([sm, lg, icon]).size).toBe(3);
  });

  it("calls onClick, and not when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();

    rerender(
      <Button disabled onClick={onClick}>
        Save
      </Button>
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps button semantics on another element through `render`", () => {
    render(
      <Button nativeButton={false} render={<span />}>
        Menu
      </Button>
    );
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button.tagName).toBe("SPAN");
    expect(button.getAttribute("tabindex")).toBe("0");
  });

  it("styles a real link through buttonStyles", () => {
    render(
      <a href="/status" {...buttonStyles({ variant: "outline" })}>
        Status
      </a>
    );
    const link = screen.getByRole("link", { name: "Status" });
    expect(link.className).toBe(buttonStyles({ variant: "outline" }).className);
  });
});
