import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../geo.js", () => ({
  lookupArtistLocation: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../spotify.js", () => ({ fetchCurrentlyPlaying: vi.fn() }));
vi.mock("../LeafletMap.jsx", () => ({
  default: () => <div data-testid="leaflet-map" />,
}));

import { lookupArtistLocation } from "../../geo.js";
import { fetchCurrentlyPlaying } from "../../spotify.js";
import MapView from "../MapView.jsx";

describe("MapView poll loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("refreshes (does not log out) when a poll returns 401", async () => {
    fetchCurrentlyPlaying.mockRejectedValue(new Error("TOKEN_EXPIRED"));
    const onTokenExpired = vi.fn().mockResolvedValue(undefined);
    render(<MapView token="t" onTokenExpired={onTokenExpired} />);
    await waitFor(() => expect(onTokenExpired).toHaveBeenCalledTimes(1));
  });

  it("retries after the rate-limit delay", async () => {
    vi.useFakeTimers();
    fetchCurrentlyPlaying.mockRejectedValue(new Error("RATE_LIMITED:2"));
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(0); // initial poll rejects, schedules retry
    const callsAfterInitial = fetchCurrentlyPlaying.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000); // fire the scheduled retry
    expect(fetchCurrentlyPlaying.mock.calls.length).toBeGreaterThan(
      callsAfterInitial,
    );
    vi.useRealTimers();
  });

  it("guards against concurrent refreshes across overlapping polls", async () => {
    vi.useFakeTimers();
    fetchCurrentlyPlaying.mockRejectedValue(new Error("TOKEN_EXPIRED"));
    let resolveRefresh;
    const onTokenExpired = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(<MapView token="t" onTokenExpired={onTokenExpired} />);
    await vi.advanceTimersByTimeAsync(0); // initial poll -> refresh in flight (pending)
    await vi.advanceTimersByTimeAsync(5000); // interval fires a 2nd poll while pending
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    resolveRefresh?.();
    vi.useRealTimers();
  });

  it("looks up the artist and renders the map when a track is playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue({
      artistName: "Radiohead",
      trackName: "Idioteque",
    });
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("leaflet-map")).toBeInTheDocument(),
    );
    expect(lookupArtistLocation).toHaveBeenCalledWith("Radiohead");
  });

  it("shows the idle message when nothing is playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(null);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("Play something on Spotify")).toBeInTheDocument(),
    );
  });

  it("shows the error message on an unrecognized poll error", async () => {
    fetchCurrentlyPlaying.mockRejectedValue(new Error("SPOTIFY_ERROR:500"));
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByText("Something went wrong. Check the console."),
      ).toBeInTheDocument(),
    );
  });
});
