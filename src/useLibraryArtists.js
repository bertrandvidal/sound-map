import { useEffect, useRef, useState } from "react";
import { fetchFollowedArtists } from "./spotify.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sequential resolution loop, one in-flight /api/geocode call at a time. Runs
// at app boot (keyed on token) regardless of whether explore mode is visible,
// so the map has clustered markers ready by the time the user opens it.
export function useLibraryArtists(token) {
  const [artists, setArtists] = useState([]);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [scopeMissing, setScopeMissing] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const isLive = () => !cancelled && mountedRef.current;

    function updateArtist(id, patch) {
      setArtists((prev) =>
        prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      );
    }

    // Resolves one artist, retrying in place on "throttled" until it gets a
    // terminal result. Never advances resolvedCount for a throttled retry.
    async function resolveArtist(artist) {
      for (;;) {
        if (!isLive()) return;

        let result;
        try {
          const response = await fetch("/api/geocode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              artistId: artist.id,
              artistName: artist.name,
            }),
          });
          // Non-200 (e.g. a raw 500 from an Upstash outage, or 401/400/405)
          // is treated as a resolution failure for this artist rather than
          // retried: retrying an outage would spin the loop hot, and this
          // artist isn't special — the user just sees it as unresolved,
          // same as a legitimate "not_found". Only "throttled" (a 200
          // response) retries, since that's the server explicitly asking us
          // to wait, with a bounded backoff it names itself.
          result = response.ok
            ? await response.json()
            : { status: "not_found" };
        } catch {
          // Network failure: same treatment as a non-200 above.
          result = { status: "not_found" };
        }

        if (!isLive()) return;

        if (result.status === "throttled") {
          await delay(result.retryAfterMs);
          continue;
        }

        if (result.status === "resolved") {
          updateArtist(artist.id, {
            status: "resolved",
            lat: result.lat,
            lng: result.lng,
            placeName: result.placeName,
          });
        } else {
          updateArtist(artist.id, { status: "not_found" });
        }
        if (isLive()) setResolvedCount((c) => c + 1);
        return;
      }
    }

    async function run() {
      setScopeMissing(false);

      let followed;
      try {
        followed = await fetchFollowedArtists(token);
      } catch (err) {
        if (!isLive()) return;
        if (err.message === "SPOTIFY_ERROR:403") setScopeMissing(true);
        return;
      }

      if (!isLive()) return;

      const initial = followed.map((a) => ({ ...a, status: "pending" }));
      setArtists(initial);
      setTotal(initial.length);
      setResolvedCount(0);

      for (const artist of initial) {
        if (!isLive()) return;
        await resolveArtist(artist);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [token]);

  return { artists, resolvedCount, total, scopeMissing };
}
