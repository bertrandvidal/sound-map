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

  it("renders a login link to the server's /api/login and a button", () => {
    render(<LandingPage error={null} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/api/login");
    expect(
      screen.getByRole("button", { name: /log in with spotify/i }),
    ).toBeInTheDocument();
  });

  it("notes that some features may require a premium account", () => {
    render(<LandingPage error={null} />);
    expect(screen.getByText(/premium account/i)).toBeInTheDocument();
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

  it("shows a message when the OAuth state check fails", () => {
    render(<LandingPage error="state_mismatch" />);
    expect(screen.getByText(/could not be verified/i)).toBeInTheDocument();
  });
});
