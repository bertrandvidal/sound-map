import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({ refreshAccessToken: vi.fn() }));
vi.mock("../components/MapView.jsx", () => ({
  default: ({ onTokenExpired }) => (
    <button type="button" data-testid="map" onClick={onTokenExpired}>
      map
    </button>
  ),
}));
vi.mock("../components/LoginButton.jsx", () => ({
  default: ({ error }) => <div data-testid="login">{error ?? "login"}</div>,
}));

import App from "../App.jsx";
import { refreshAccessToken } from "../auth.js";

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("shows the map once the session bootstrap returns a token", async () => {
    refreshAccessToken.mockResolvedValue("access-token");
    render(<App />);
    expect(await screen.findByTestId("map")).toBeInTheDocument();
  });

  it("shows the login screen when there is no session", async () => {
    refreshAccessToken.mockRejectedValue(new Error("SESSION_EXPIRED"));
    render(<App />);
    expect(await screen.findByTestId("login")).toBeInTheDocument();
  });

  it("recovers by refreshing when the token expires, staying on the map", async () => {
    refreshAccessToken.mockResolvedValueOnce("token-1"); // bootstrap
    render(<App />);
    const map = await screen.findByTestId("map");
    refreshAccessToken.mockResolvedValueOnce("token-2"); // the refresh
    fireEvent.click(map);
    await waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("map")).toBeInTheDocument();
  });

  it("logs out when the refresh during token expiry fails", async () => {
    refreshAccessToken.mockResolvedValueOnce("token-1"); // bootstrap
    render(<App />);
    const map = await screen.findByTestId("map");
    refreshAccessToken.mockRejectedValueOnce(new Error("SESSION_EXPIRED"));
    fireEvent.click(map);
    expect(await screen.findByTestId("login")).toBeInTheDocument();
  });
});
