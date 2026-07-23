import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WorldMapBackdrop from "../WorldMapBackdrop.jsx";

describe("WorldMapBackdrop", () => {
  it("renders five album bubbles", () => {
    const { container } = render(<WorldMapBackdrop />);
    expect(container.querySelectorAll('[data-testid="bubble"]')).toHaveLength(
      5,
    );
  });

  it("is decorative (aria-hidden) so it is skipped by assistive tech", () => {
    const { container } = render(<WorldMapBackdrop />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
