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

  it("renders a terminal failure notice, not nothing, once resolvedCount + failedCount reach total with failures present", () => {
    // The loop has finished attempting every artist, but some ended in a
    // backend failure rather than a resolution — for a total Upstash
    // outage that's EVERY artist. Silently hiding here (the old behavior)
    // meant an outage looked exactly like "resolved successfully, and it's
    // empty": ArtistClusterLayer only renders status === "resolved"
    // markers, so a fully-failed run showed an empty map with no badge and
    // no error anywhere. The badge must say something true instead.
    render(
      <LibraryLoadingBadge resolvedCount={300} total={359} failedCount={59} />,
    );
    expect(
      screen.getByText("Library loaded — 59 artists could not be resolved"),
    ).toBeInTheDocument();
  });

  it("shows the truthful terminal notice when EVERY artist failed (the total-outage case), not a silent empty pill", () => {
    // resolvedCount is 0: nothing resolved at all, e.g. an Upstash outage
    // for the entire library. Before this fix, `total===0 || 0+500>=500`
    // hid the badge exactly as if the library were empty and done —
    // indistinguishable from a real 0-artist library. That's Finding 3.
    render(
      <LibraryLoadingBadge resolvedCount={0} total={500} failedCount={500} />,
    );
    expect(
      screen.getByText("Library loaded — 500 artists could not be resolved"),
    ).toBeInTheDocument();
  });

  it("uses singular wording for exactly one failure", () => {
    render(<LibraryLoadingBadge resolvedCount={0} total={1} failedCount={1} />);
    expect(
      screen.getByText("Library loaded — 1 artist could not be resolved"),
    ).toBeInTheDocument();
  });

  it("renders the terminal failure notice as an accessible polite live region too", () => {
    render(<LibraryLoadingBadge resolvedCount={0} total={1} failedCount={1} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Library loaded — 1 artist could not be resolved",
    );
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("renders nothing once resolvedCount reaches total with no failures at all (the fully-successful terminal case)", () => {
    const { container } = render(
      <LibraryLoadingBadge resolvedCount={359} total={359} failedCount={0} />,
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
