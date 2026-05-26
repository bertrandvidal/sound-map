import { useEffect, useRef, useState } from "react";
import { lookupArtistLocation } from "../geo.js";
import { fetchCurrentlyPlaying } from "../spotify.js";
import LeafletMap from "./LeafletMap.jsx";

const POLL_MS = 3_000;
const PACIFIC_FALLBACK = { lat: 0, lng: -160, placeName: "Unknown location" };

export default function MapView({ token, onSessionExpired }) {
  const [track, setTrack] = useState(null);
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("loading");
  const lastArtistRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
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
        if (err.message === "TOKEN_EXPIRED") {
          onSessionExpired();
          return;
        }
        if (err.message.startsWith("RATE_LIMITED:")) {
          const seconds = parseInt(err.message.split(":")[1], 10);
          // safe to schedule even near unmount: poll() checks cancelled at the top
          setTimeout(poll, seconds * 1000);
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
  }, [token, onSessionExpired]);

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
