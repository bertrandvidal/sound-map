import { useEffect, useRef, useState } from "react";
import { lookupArtistLocation } from "../geo.js";
import { classifyPollError } from "../pollError.js";
import { fetchCurrentlyPlaying } from "../spotify.js";
import LeafletMap from "./LeafletMap.jsx";

const POLL_MS = 5_000;
const PACIFIC_FALLBACK = { lat: 0, lng: -160, placeName: "Unknown location" };

export default function MapView({ token, onTokenExpired }) {
  const [track, setTrack] = useState(null);
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("loading");
  const lastArtistRef = useRef(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const current = await fetchCurrentlyPlaying(token);
        if (cancelled) return;

        if (!current) {
          if (import.meta.env.DEV) console.info("[poll] nothing playing");
          setStatus("idle");
          return;
        }

        // update track immediately; location catches up asynchronously
        setTrack(current);
        setStatus("playing");
        if (import.meta.env.DEV) {
          console.info(
            `[poll] now playing: ${current.artistName} – ${current.trackName}`,
          );
        }

        if (current.artistName !== lastArtistRef.current) {
          lastArtistRef.current = current.artistName;
          if (import.meta.env.DEV) {
            console.info(
              `[poll] artist changed, looking up ${current.artistName}`,
            );
          }
          const loc = await lookupArtistLocation(current.artistName);
          if (!cancelled) setLocation(loc ?? PACIFIC_FALLBACK);
        }
      } catch (err) {
        if (cancelled) return;
        const action = classifyPollError(err.message);
        if (action.type === "refresh") {
          // Guard: one refresh in flight, even if overlapping polls all 401.
          if (refreshingRef.current) return;
          refreshingRef.current = true;
          if (import.meta.env.DEV)
            console.info("[poll] token expired, refreshing");
          try {
            await onTokenExpired();
          } finally {
            refreshingRef.current = false;
          }
          return;
        }
        if (action.type === "retry") {
          if (import.meta.env.DEV) {
            console.info(`[poll] rate limited, retrying in ${action.seconds}s`);
          }
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
  }, [token, onTokenExpired]);

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
  return <LeafletMap track={track} location={location} />;
}
