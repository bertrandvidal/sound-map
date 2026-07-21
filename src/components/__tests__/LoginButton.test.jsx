import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LoginButton from "../LoginButton.jsx";

describe("LoginButton", () => {
  it("renders a Spotify login link", () => {
    render(<LoginButton error={null} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("accounts.spotify.com/authorize"),
    );
    expect(
      screen.getByRole("button", { name: /login with spotify/i }),
    ).toBeInTheDocument();
  });

  it("shows the session-expired message when that error is set", () => {
    render(<LoginButton error="session_expired" />);
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("shows the access-denied message when that error is set", () => {
    render(<LoginButton error="access_denied" />);
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });

  it("shows the login-failed message when token exchange failed", () => {
    render(<LoginButton error="token_exchange_failed" />);
    expect(screen.getByText(/login failed/i)).toBeInTheDocument();
  });
});
