import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sparkline, sparklineSegments } from "./sparkline.tsx";

const dots = (container: HTMLElement) => [
  ...container.querySelectorAll("path[data-sparkline-dot]"),
];
const lines = (container: HTMLElement) => [
  ...container.querySelectorAll("g > path[vector-effect]"),
];

describe(sparklineSegments, () => {
  it("splits runs at gaps", () => {
    const segments = sparklineSegments([10, 20, null, 30], 30, 10);
    expect(segments.map((points) => points.length)).toStrictEqual([2, 1]);
  });

  it("centres a single value horizontally", () => {
    const [[point] = []] = sparklineSegments([42], 120, 32);
    expect(point?.x).toBe(60);
  });
});

describe(Sparkline, () => {
  it("draws a dot for an isolated reading, and a line for a run", () => {
    const { container } = render(
      <Sparkline label="Latency" values={[null, 120, null, 80, 90, null]} />
    );
    const [dot] = dots(container);
    expect(dots(container)).toHaveLength(1);
    expect(dot?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+h0$/u);
    expect(lines(container)).toHaveLength(1);
    expect(screen.getByText("Latency")).toBeDefined();
  });

  it("draws a dot for a single sample", () => {
    const { container } = render(<Sparkline label="One" values={[250]} />);
    expect(dots(container)).toHaveLength(1);
    expect(lines(container)).toHaveLength(0);
  });

  it("draws the empty baseline without samples", () => {
    const { container } = render(
      <Sparkline label="None" values={[null, null]} />
    );
    expect(dots(container)).toHaveLength(0);
    expect(container.querySelector("line")).not.toBeNull();
  });
});
