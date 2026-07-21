import { useEffect, useRef, useState } from "react";
import { lookupArtistLocation } from "../geo.js";
import { classifyPollError } from "../pollError.js";
import { fetchCurrentlyPlaying } from "../spotify.js";
import LeafletMap from "./LeafletMap.jsx";

const POLL_MS = 3_000;
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
        if (import.meta.env.DEV) {
          // Debug: confirms whether empty-token requests occur (logout hypothesis).
          console.debug("[poll] token present:", Boolean(token));
        }
        const current = await fetchCurrentlyPlaying(token);
        if (cancelled) return;

        if (!current) {
          setStatus("idle");
          return;
        }

        // update track immediately; location catches up asynchronously
        setTrack(current);
        setStatus("playing");

        if (current.artistName !== lastArtistRef.current) {
          lastArtistRef.current = current.artistName;
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
          try {
            await onTokenExpired();
          } finally {
            refreshingRef.current = false;
          }
          return;
        }
        if (action.type === "retry") {
          // safe to schedule even near unmount: poll() checks cancelled at the top
          setTimeout(poll, action.seconds * 1000);
          return;
        }
        console.error("Poll error:", err);
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
