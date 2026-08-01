import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../geo.js", () => ({
  lookupArtistLocation: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../spotify.js", () => ({
  fetchCurrentlyPlaying: vi.fn(),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  skipToNext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../useLibraryArtists.js", () => ({
  useLibraryArtists: vi.fn(),
}));
vi.mock("../LeafletMap.jsx", () => ({
  default: ({ exploreMode, libraryArtists, onSelectArtist }) => (
    <div
      data-testid="leaflet-map"
      data-explore-mode={exploreMode ? "true" : "false"}
    >
      <span data-testid="library-artist-count">
        {(libraryArtists ?? []).length}
      </span>
      {exploreMode && (
        <button
          type="button"
          onClick={() => onSelectArtist({ id: "artist-1" })}
        >
          select-artist
        </button>
      )}
    </div>
  ),
}));
vi.mock("../NowPlayingCard.jsx", () => ({
  default: ({ onPlayPause, onNext, controlMessage }) => (
    <div data-testid="now-playing-card">
      <button type="button" onClick={onPlayPause}>
        play-pause
      </button>
      <button type="button" onClick={onNext}>
        next
      </button>
      {controlMessage ? <span>{controlMessage}</span> : null}
    </div>
  ),
}));
vi.mock("../BrowseLibraryButton.jsx", () => ({
  default: ({ exploreMode, onToggle }) => (
    <button
      type="button"
      data-testid="browse-library-button"
      onClick={onToggle}
    >
      {exploreMode ? "explore-mode-on" : "explore-mode-off"}
    </button>
  ),
}));
vi.mock("../LibraryLoadingBadge.jsx", () => ({
  default: ({ resolvedCount, total }) => (
    <div data-testid="library-loading-badge">
      {resolvedCount}/{total}
    </div>
  ),
}));

import { lookupArtistLocation } from "../../geo.js";
import {
  fetchCurrentlyPlaying,
  pause,
  play,
  skipToNext,
} from "../../spotify.js";
import { useLibraryArtists } from "../../useLibraryArtists.js";
import MapView from "../MapView.jsx";

const PLAYING_TRACK = {
  artistName: "Radiohead",
  artistNames: "Radiohead",
  trackName: "Idioteque",
  albumImageUrl: "https://example.com/cover.jpg",
  trackId: "track-1",
  isPlaying: true,
  progressMs: 1000,
  durationMs: 300_000,
};

describe("MapView poll loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    useLibraryArtists.mockReturnValue({
      artists: [],
      resolvedCount: 0,
      total: 0,
      scopeMissing: false,
    });
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
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("leaflet-map")).toBeInTheDocument(),
    );
    expect(lookupArtistLocation).toHaveBeenCalledWith("Radiohead");
  });

  it("renders the now-playing card once a track is playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
  });

  it("pauses via the control handler when the track is playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("play-pause"));
    await waitFor(() => expect(pause).toHaveBeenCalledWith("t"));
    expect(play).not.toHaveBeenCalled();
  });

  it("skips to next via the control handler", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(skipToNext).toHaveBeenCalledWith("t"));
  });

  it("swallows a resync error after a successful skip", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
    const callsBeforeSkip = fetchCurrentlyPlaying.mock.calls.length;
    fetchCurrentlyPlaying.mockRejectedValueOnce(new Error("SPOTIFY_ERROR:500")); // resync fired by handleNext after the skip succeeds
    fireEvent.click(screen.getByText("next"));
    await waitFor(() => expect(skipToNext).toHaveBeenCalledWith("t"));
    // the follow-up resync's rejection is swallowed: no crash, no error status
    await waitFor(() =>
      expect(fetchCurrentlyPlaying.mock.calls.length).toBeGreaterThan(
        callsBeforeSkip,
      ),
    );
    expect(screen.getByTestId("now-playing-card")).toBeInTheDocument();
  });

  it("shows a control message when playback control fails", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    pause.mockRejectedValueOnce(new Error("PLAYBACK_UNAVAILABLE"));
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("play-pause"));
    await waitFor(() =>
      expect(
        screen.getByText("Playback control not available"),
      ).toBeInTheDocument(),
    );
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

  it("refreshes the token when a control action returns TOKEN_EXPIRED", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    pause.mockRejectedValueOnce(new Error("TOKEN_EXPIRED"));
    const onTokenExpired = vi.fn().mockResolvedValue(undefined);
    render(<MapView token="t" onTokenExpired={onTokenExpired} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("play-pause"));
    await waitFor(() => expect(onTokenExpired).toHaveBeenCalled());
  });
});

describe("MapView explore mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    useLibraryArtists.mockReturnValue({
      artists: [],
      resolvedCount: 0,
      total: 0,
      scopeMissing: false,
    });
  });

  it("toggles exploreMode via BrowseLibraryButton and swaps LeafletMap into the clustered library view", async () => {
    useLibraryArtists.mockReturnValue({
      artists: [
        { id: "a1", name: "Artist One", status: "resolved" },
        { id: "a2", name: "Artist Two", status: "resolved" },
      ],
      resolvedCount: 2,
      total: 2,
      scopeMissing: false,
    });
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("leaflet-map")).toHaveAttribute(
        "data-explore-mode",
        "false",
      ),
    );

    fireEvent.click(screen.getByTestId("browse-library-button"));
    expect(screen.getByTestId("leaflet-map")).toHaveAttribute(
      "data-explore-mode",
      "true",
    );
    // the artists returned by useLibraryArtists flow through as libraryArtists
    expect(screen.getByTestId("library-artist-count")).toHaveTextContent("2");

    fireEvent.click(screen.getByTestId("browse-library-button"));
    expect(screen.getByTestId("leaflet-map")).toHaveAttribute(
      "data-explore-mode",
      "false",
    );
  });

  it("passes resolvedCount/total from useLibraryArtists to LibraryLoadingBadge", async () => {
    useLibraryArtists.mockReturnValue({
      artists: [],
      resolvedCount: 3,
      total: 10,
      scopeMissing: false,
    });
    fetchCurrentlyPlaying.mockResolvedValue(null);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("library-loading-badge")).toHaveTextContent(
        "3/10",
      ),
    );
  });

  it("selecting an artist plays it via runControl using the artist's context_uri", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("leaflet-map")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("browse-library-button"));
    fireEvent.click(screen.getByText("select-artist"));

    await waitFor(() =>
      expect(play).toHaveBeenCalledWith("t", {
        contextUri: "spotify:artist:artist-1",
      }),
    );
  });

  it("routes a failed artist selection through runControl's existing TOKEN_EXPIRED refresh path", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    play.mockRejectedValueOnce(new Error("TOKEN_EXPIRED"));
    const onTokenExpired = vi.fn().mockResolvedValue(undefined);
    render(<MapView token="t" onTokenExpired={onTokenExpired} />);
    await waitFor(() =>
      expect(screen.getByTestId("leaflet-map")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("browse-library-button"));
    fireEvent.click(screen.getByText("select-artist"));

    await waitFor(() => expect(onTokenExpired).toHaveBeenCalled());
  });

  it("regression: stays in explore mode after selecting an artist (no auto switch back to now-playing)", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("leaflet-map")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("browse-library-button"));
    expect(screen.getByTestId("leaflet-map")).toHaveAttribute(
      "data-explore-mode",
      "true",
    );

    fireEvent.click(screen.getByText("select-artist"));
    await waitFor(() => expect(play).toHaveBeenCalled());

    // exploreMode must still be true — selection starts playback but does
    // not leave the clustered library view.
    expect(screen.getByTestId("leaflet-map")).toHaveAttribute(
      "data-explore-mode",
      "true",
    );
  });

  it("surfaces a stale-scope 403 (scopeMissing) through the existing control-message channel", async () => {
    useLibraryArtists.mockReturnValue({
      artists: [],
      resolvedCount: 0,
      total: 0,
      scopeMissing: true,
    });
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);

    await waitFor(() =>
      expect(
        screen.getByText("Log out and back in to enable Browse Library"),
      ).toBeInTheDocument(),
    );
  });

  it("does not show a control message when scopeMissing is false", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(PLAYING_TRACK);
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId("now-playing-card")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Log out and back in to enable Browse Library"),
    ).not.toBeInTheDocument();
  });
});
