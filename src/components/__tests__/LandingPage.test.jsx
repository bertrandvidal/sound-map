import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TAGLINES } from "../../taglines.js";
import LandingPage from "../LandingPage.jsx";

describe("LandingPage", () => {
  it("renders the wordmark", () => {
    render(<LandingPage error={null} />);
    expect(
      screen.getByRole("heading", { name: /sound-map/i }),
    ).toBeInTheDocument();
  });

  it("renders a tagline from the pool", () => {
    render(<LandingPage error={null} />);
    const found = TAGLINES.some((t) => screen.queryByText(t) !== null);
    expect(found).toBe(true);
  });

  it("renders a Spotify login link and button", () => {
    render(<LandingPage error={null} />);
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("accounts.spotify.com/authorize"),
    );
    expect(
      screen.getByRole("button", { name: /log in with spotify/i }),
    ).toBeInTheDocument();
  });

  it("shows the session-expired message", () => {
    render(<LandingPage error="session_expired" />);
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("shows the access-denied message", () => {
    render(<LandingPage error="access_denied" />);
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });

  it("shows the login-failed message on token exchange failure", () => {
    render(<LandingPage error="token_exchange_failed" />);
    expect(screen.getByText(/login failed/i)).toBeInTheDocument();
  });
});
