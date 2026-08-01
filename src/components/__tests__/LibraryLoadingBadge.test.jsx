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
