import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LibraryLoadingBadge from "../LibraryLoadingBadge.jsx";

describe("LibraryLoadingBadge", () => {
  it("renders nothing when total is 0", () => {
    const { container } = render(
      <LibraryLoadingBadge resolvedCount={0} total={0} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once resolvedCount reaches total", () => {
    const { container } = render(
      <LibraryLoadingBadge resolvedCount={359} total={359} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once resolvedCount + failedCount together reach total", () => {
    // The loop has finished attempting every artist even though some ended
    // in a backend failure rather than a resolution — the badge's job is
    // signalling "still loading", not "fully resolved", so it must not hang
    // forever just because some artists came back unavailable (see
    // useLibraryArtists.js's failedCount).
    const { container } = render(
      <LibraryLoadingBadge resolvedCount={300} total={359} failedCount={59} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps showing while some artists are still pending, even with failures counted in", () => {
    render(
      <LibraryLoadingBadge resolvedCount={100} total={359} failedCount={59} />,
    );
    expect(screen.getByText("Loading library 100/359")).toBeInTheDocument();
  });

  it("renders the counter text while resolution is in progress", () => {
    render(<LibraryLoadingBadge resolvedCount={12} total={359} />);
    expect(screen.getByText("Loading library 12/359")).toBeInTheDocument();
  });

  it("exposes progress via an accessible polite live region", () => {
    render(<LibraryLoadingBadge resolvedCount={12} total={359} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading library 12/359");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("drops the live region once loading completes, signalling completion to screen readers", () => {
    render(<LibraryLoadingBadge resolvedCount={359} total={359} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
