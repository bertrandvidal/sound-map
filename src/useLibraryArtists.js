import { useEffect, useRef, useState } from "react";
import { fetchFollowedArtists } from "./spotify.js";

// Cancellable delay: rejects immediately (or as soon as `signal` aborts)
// instead of resolving, so a stale throttled-retry timer never fires a
// request for a loop whose effect has already been cleaned up.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
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
    // One controller per effect run (i.e. per token). Its cleanup aborts
    // whatever /api/geocode request is in flight and cancels any pending
    // throttled-retry timer, so a token change (e.g. the routine
    // TOKEN_EXPIRED refresh in MapView.jsx) can never leave a stale request
    // racing the new loop's first request — at most one request is ever
    // in flight across a token change.
    const controller = new AbortController();
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
            signal: controller.signal,
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
          // Covers both a genuine network failure (treated like a non-200
          // above) and this request being aborted by cleanup on a token
          // change — the isLive() check right below discards `result` in
          // the abort case, so it never gets marked not_found or counted.
          result = { status: "not_found" };
        }

        if (!isLive()) return;

        if (result.status === "throttled") {
          try {
            await delay(result.retryAfterMs, controller.signal);
          } catch {
            return; // aborted while waiting to retry — loop is dead, stop
          }
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
      controller.abort();
    };
  }, [token]);

  return { artists, resolvedCount, total, scopeMissing };
}
