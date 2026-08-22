import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ThemeToggleButton from "../ThemeToggleButton.jsx";

describe("ThemeToggleButton", () => {
  it('renders "Light map" when darkMode is true', () => {
    render(<ThemeToggleButton darkMode={true} onToggle={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Light map" }),
    ).toBeInTheDocument();
  });

  it('renders "Dark map" when darkMode is false', () => {
    render(<ThemeToggleButton darkMode={false} onToggle={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Dark map" }),
    ).toBeInTheDocument();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<ThemeToggleButton darkMode={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Light map" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
