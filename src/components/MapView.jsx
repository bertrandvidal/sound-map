import { useCallback, useEffect, useRef, useState } from "react";
import { devLog } from "../devLog.js";
import { lookupArtistLocation } from "../geo.js";
import { classifyPollError } from "../pollError.js";
import { fetchCurrentlyPlaying, pause, play, skipToNext } from "../spotify.js";
import LeafletMap from "./LeafletMap.jsx";
import NowPlayingCard from "./NowPlayingCard.jsx";

const POLL_MS = 5_000;
const PACIFIC_FALLBACK = { lat: 0, lng: -160, placeName: "Unknown location" };

export default function MapView({ token, onTokenExpired }) {
  const [track, setTrack] = useState(null);
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("loading");
  const [controlMessage, setControlMessage] = useState(null);
  const lastArtistRef = useRef(null);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch the currently-playing track and update state. Throws on API error so
  // callers (the poll loop and the control handlers) can apply their own
  // error handling. Both share this so a control action can refresh instantly.
  const syncNowPlaying = useCallback(async () => {
    const current = await fetchCurrentlyPlaying(token);
    if (!mountedRef.current) return;

    if (!current) {
      devLog("[poll] nothing playing");
      setStatus("idle");
      return;
    }

    // update track immediately; location catches up asynchronously
    setTrack(current);
    setStatus("playing");
    devLog(`[poll] now playing: ${current.artistName} – ${current.trackName}`);

    if (current.artistName !== lastArtistRef.current) {
      lastArtistRef.current = current.artistName;
      devLog(`[poll] artist changed, looking up ${current.artistName}`);
      const loc = await lookupArtistLocation(current.artistName);
      if (mountedRef.current) setLocation(loc ?? PACIFIC_FALLBACK);
    }
  }, [token]);

  // Shared TOKEN_EXPIRED refresh path, guarded so only one refresh runs at a
  // time even across overlapping poll/control errors.
  const refreshToken = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    devLog("[poll] token expired, refreshing");
    try {
      await onTokenExpired();
    } finally {
      refreshingRef.current = false;
    }
  }, [onTokenExpired]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (cancelled) return;
      try {
        await syncNowPlaying();
      } catch (err) {
        if (cancelled) return;
        const action = classifyPollError(err.message);
        if (action.type === "refresh") {
          await refreshToken();
          return;
        }
        if (action.type === "retry") {
          devLog(`[poll] rate limited, retrying in ${action.seconds}s`);
          // safe to schedule even near unmount: poll() checks cancelled at the top
          setTimeout(poll, action.seconds * 1000);
          return;
        }
        console.error("[poll] error:", err.message);
        setStatus("error");
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [syncNowPlaying, refreshToken]);

  async function runControl(action) {
    try {
      await action();
      setControlMessage(null);
      return true;
    } catch (err) {
      if (err.message === "TOKEN_EXPIRED") {
        await refreshToken();
      } else {
        setControlMessage("Playback control not available");
      }
      return false;
    }
  }

  async function handlePlayPause() {
    const wasPlaying = track?.isPlaying;
    const ok = await runControl(() =>
      wasPlaying ? pause(token) : play(token),
    );
    if (!ok) return;
    // Optimistic flip so the icon updates immediately. We deliberately do NOT
    // re-sync here: Spotify's currently-playing read is eventually consistent
    // and for a moment still reports the old is_playing, which would clobber
    // this flip and make the button flicker back. The 5s poll reconciles.
    setTrack((t) => (t ? { ...t, isPlaying: !wasPlaying } : t));
  }

  async function handleNext() {
    const ok = await runControl(() => skipToNext(token));
    if (!ok) return;
    syncNowPlaying().catch(() => {});
  }

  if (status === "idle") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontFamily: "sans-serif",
        }}
      >
        <p>Play something on Spotify</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontFamily: "sans-serif",
        }}
      >
        <p>Something went wrong. Check the console.</p>
      </div>
    );
  }

  // renders for 'loading' (initial) and 'playing' — LeafletMap handles null track/location
  return (
    <div style={{ position: "relative", height: "100vh", width: "100%" }}>
      <LeafletMap track={track} location={location} />
      {track && (
        <NowPlayingCard
          track={track}
          placeName={location?.placeName}
          onPlayPause={handlePlayPause}
          onNext={handleNext}
          controlMessage={controlMessage}
        />
      )}
    </div>
  );
}
