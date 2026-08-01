import { useCallback, useEffect, useRef, useState } from "react";
import { devLog } from "../devLog.js";
import { lookupArtistLocation } from "../geo.js";
import { classifyPollError } from "../pollError.js";
import { fetchCurrentlyPlaying, pause, play, skipToNext } from "../spotify.js";
import { useLibraryArtists } from "../useLibraryArtists.js";
import BrowseLibraryButton from "./BrowseLibraryButton.jsx";
import LeafletMap from "./LeafletMap.jsx";
import LibraryLoadingBadge from "./LibraryLoadingBadge.jsx";
import NowPlayingCard from "./NowPlayingCard.jsx";

const POLL_MS = 5_000;
const PACIFIC_FALLBACK = { lat: 0, lng: -160, placeName: "Unknown location" };
const SCOPE_WARNING = "Log out and back in to enable Browse Library";

export default function MapView({ token, onTokenExpired }) {
  const [track, setTrack] = useState(null);
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("loading");
  const [controlMessage, setControlMessage] = useState(null);
  const [exploreMode, setExploreMode] = useState(false);
  const lastArtistRef = useRef(null);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);

  // Runs unconditionally from app boot regardless of exploreMode, per spec —
  // the background resolution loop keeps the library pre-populated so
  // explore mode is ready by the time the user opens it.
  const { artists, resolvedCount, total, scopeMissing } =
    useLibraryArtists(token);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surfaces a stale-scope 403 (a session authorized before `user-follow-read`
  // was added — see the design doc's migration note) alongside the existing
  // transient controlMessage, without storing it in that same state. It's a
  // *persistent* condition (stays true until the user re-logs-in) riding on
  // a channel (`controlMessage`) that `runControl` unconditionally clears on
  // every successful play/pause/skip/select — storing the warning there
  // caused it to be silently wiped out by the next unrelated successful
  // control action. Deriving it instead means there's no state for anything
  // to clobber: a transient control error still wins while it's showing
  // (matches existing single-message-slot UI), and the scope warning simply
  // reappears on its own once that transient message clears, because
  // `scopeMissing` itself hasn't changed.
  const displayMessage =
    controlMessage ?? (scopeMissing ? SCOPE_WARNING : null);

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

  // Starts playback of the selected library artist. Routes through the
  // existing runControl helper (TOKEN_EXPIRED -> refresh, other errors ->
  // controlMessage) rather than duplicating that handling here.
  // Deliberately does NOT change exploreMode: selecting an artist stays on
  // the clustered library view — NowPlayingCard already reflects playback
  // regardless of exploreMode, so there's no "switch back" transition.
  async function handleSelectArtist(artist) {
    await runControl(() =>
      play(token, { contextUri: `spotify:artist:${artist.id}` }),
    );
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
      <LeafletMap
        track={track}
        location={location}
        exploreMode={exploreMode}
        libraryArtists={artists}
        onSelectArtist={handleSelectArtist}
      />
      {track && (
        <NowPlayingCard
          track={track}
          placeName={location?.placeName}
          onPlayPause={handlePlayPause}
          onNext={handleNext}
          controlMessage={displayMessage}
        />
      )}
      <LibraryLoadingBadge resolvedCount={resolvedCount} total={total} />
      <BrowseLibraryButton
        exploreMode={exploreMode}
        onToggle={() => setExploreMode((v) => !v)}
      />
    </div>
  );
}
