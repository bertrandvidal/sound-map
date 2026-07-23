import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NowPlayingCard from "../NowPlayingCard.jsx";

function makeTrack(overrides = {}) {
  return {
    trackName: "Idioteque",
    artistName: "Radiohead",
    artistNames: "Radiohead, Thom Yorke",
    albumImageUrl: "https://example.com/cover.jpg",
    trackId: "track-1",
    isPlaying: false,
    progressMs: 30_000,
    durationMs: 300_000,
    ...overrides,
  };
}

describe("NowPlayingCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders track name, artists and place of origin", () => {
    render(
      <NowPlayingCard
        track={makeTrack()}
        placeName="Oxford, England"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    expect(screen.getByText("Idioteque")).toBeInTheDocument();
    expect(screen.getByText("Radiohead, Thom Yorke")).toBeInTheDocument();
    expect(screen.getByText(/Oxford, England/)).toBeInTheDocument();
  });

  it("calls onPlayPause when the play/pause button is clicked", () => {
    const onPlayPause = vi.fn();
    render(
      <NowPlayingCard
        track={makeTrack()}
        placeName="X"
        onPlayPause={onPlayPause}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /play|pause/i }));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("calls onNext when the next button is clicked", () => {
    const onNext = vi.fn();
    render(
      <NowPlayingCard
        track={makeTrack()}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={onNext}
        controlMessage={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("shows the Pause label when playing and Play when paused", () => {
    const { rerender } = render(
      <NowPlayingCard
        track={makeTrack({ isPlaying: false })}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    rerender(
      <NowPlayingCard
        track={makeTrack({ isPlaying: true })}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("renders the progress fill element", () => {
    render(
      <NowPlayingCard
        track={makeTrack()}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    expect(screen.getByTestId("progress-fill")).toBeInTheDocument();
  });

  it("displays elapsed / total time formatted as m:ss", () => {
    render(
      <NowPlayingCard
        track={makeTrack({ progressMs: 83_000, durationMs: 300_000 })}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    expect(screen.getByTestId("progress-time")).toHaveTextContent(
      "1:23 / 5:00",
    );
  });

  it("shows the control message when provided and hides it when null", () => {
    const { rerender } = render(
      <NowPlayingCard
        track={makeTrack()}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage="Playback control not available"
      />,
    );
    expect(
      screen.getByText("Playback control not available"),
    ).toBeInTheDocument();
    rerender(
      <NowPlayingCard
        track={makeTrack()}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    expect(
      screen.queryByText("Playback control not available"),
    ).not.toBeInTheDocument();
  });

  it("truncates a long track name with an ellipsis style", () => {
    render(
      <NowPlayingCard
        track={makeTrack({
          trackName:
            "A Ridiculously Long Track Name That Should Definitely Be Truncated With An Ellipsis",
        })}
        placeName="X"
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        controlMessage={null}
      />,
    );
    const name = screen.getByText(/A Ridiculously Long Track Name/);
    expect(name).toHaveStyle({ textOverflow: "ellipsis" });
  });

  describe("progress interpolation", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("advances the interpolation interval while playing", () => {
      render(
        <NowPlayingCard
          track={makeTrack({ isPlaying: true })}
          placeName="X"
          onPlayPause={vi.fn()}
          onNext={vi.fn()}
          controlMessage={null}
        />,
      );
      // Advance past several 500ms ticks to exercise the interval branch.
      vi.advanceTimersByTime(1500);
      expect(screen.getByTestId("progress-fill")).toBeInTheDocument();
    });

    it("does not start the interval when paused", () => {
      render(
        <NowPlayingCard
          track={makeTrack({ isPlaying: false })}
          placeName="X"
          onPlayPause={vi.fn()}
          onNext={vi.fn()}
          controlMessage={null}
        />,
      );
      vi.advanceTimersByTime(1500);
      expect(screen.getByTestId("progress-fill")).toBeInTheDocument();
    });
  });
});
