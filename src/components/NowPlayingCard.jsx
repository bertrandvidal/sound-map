import { useEffect, useRef, useState } from "react";
import { ACCENT, MUTED, SURFACE, SURFACE_ALT, TEXT } from "../theme.js";

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 5v14l9-7zM16 5h2v14h-2z" fill="currentColor" />
    </svg>
  );
}

const ellipsis = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// Milliseconds -> "m:ss" (e.g. 83000 -> "1:23").
function formatTime(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const iconButton = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: TEXT,
  cursor: "pointer",
  padding: 6,
  borderRadius: "50%",
};

export default function NowPlayingCard({
  track,
  placeName,
  onPlayPause,
  onNext,
  controlMessage,
}) {
  // Smooth progress interpolation local to the card.
  const anchorRef = useRef({ ms: 0, at: 0 });
  const [displayMs, setDisplayMs] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: trackId resets the anchor when the track changes even if progressMs coincidentally matches.
  useEffect(() => {
    anchorRef.current = { ms: track.progressMs, at: Date.now() };
    setDisplayMs(track.progressMs ?? 0);
  }, [track.progressMs, track.trackId]);

  useEffect(() => {
    if (!track.isPlaying) return;
    const id = setInterval(() => {
      const { ms, at } = anchorRef.current;
      setDisplayMs(Math.min(ms + (Date.now() - at), track.durationMs ?? ms));
    }, 500);
    return () => clearInterval(id);
  }, [track.isPlaying, track.durationMs]);

  const pct = track.durationMs
    ? Math.min(100, (displayMs / track.durationMs) * 100)
    : 0;

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 1000,
        width: 320,
        boxSizing: "border-box",
        background: SURFACE,
        color: TEXT,
        borderRadius: 12,
        padding: 12,
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {track.albumImageUrl && (
          <img
            src={track.albumImageUrl}
            alt=""
            style={{
              width: 56,
              height: 56,
              borderRadius: 8,
              objectFit: "cover",
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 15, ...ellipsis }}>
            {track.trackName}
          </div>
          <div style={{ color: MUTED, fontSize: 13, ...ellipsis }}>
            {track.artistNames}
          </div>
          <div
            style={{ color: MUTED, fontSize: 12, marginTop: 2, ...ellipsis }}
          >
            📍 {placeName ?? "Unknown location"}
          </div>
        </div>
      </div>

      {/* Read-only progress bar + time on one row — bar is purely visual, no seek handlers */}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            background: SURFACE_ALT,
            overflow: "hidden",
          }}
        >
          <div
            data-testid="progress-fill"
            style={{ width: `${pct}%`, height: "100%", background: ACCENT }}
          />
        </div>
        <div
          data-testid="progress-time"
          style={{
            color: MUTED,
            fontSize: 11,
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {formatTime(displayMs)} / {formatTime(track.durationMs)}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          marginTop: 10,
        }}
      >
        <button
          type="button"
          onClick={onPlayPause}
          aria-label={track.isPlaying ? "Pause" : "Play"}
          style={iconButton}
        >
          {track.isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next"
          style={iconButton}
        >
          <NextIcon />
        </button>
      </div>

      {controlMessage ? (
        <div
          style={{
            marginTop: 8,
            color: MUTED,
            fontSize: 12,
            textAlign: "center",
          }}
        >
          {controlMessage}
        </div>
      ) : null}
    </div>
  );
}
