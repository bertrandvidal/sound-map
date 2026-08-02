import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BrowseLibraryButton from "../BrowseLibraryButton.jsx";

describe("BrowseLibraryButton", () => {
  it('renders "Browse library" when exploreMode is false', () => {
    render(<BrowseLibraryButton exploreMode={false} onToggle={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Browse library" }),
    ).toBeInTheDocument();
  });

  it('renders "Now playing" when exploreMode is true', () => {
    render(<BrowseLibraryButton exploreMode={true} onToggle={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Now playing" }),
    ).toBeInTheDocument();
  });

  it("calls onToggle when clicked", () => {
    const onToggle = vi.fn();
    render(<BrowseLibraryButton exploreMode={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse library" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
