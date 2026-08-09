import { useEffect, useRef, useState } from "react";
import { fetchFollowedArtists } from "./spotify.js";

// The server answers a denied caller with the lock's exact remaining TTL
// (server/kv.js getThrottleRetryMs). That is ideal for a single caller and
// pathological for several: every worker denied during the same hold wakes at
// the same instant to contend for a lock only one can win, and the losers are
// denied again. A small random spread staggers the wake-ups.
const RETRY_JITTER_MS = 250;

// Workers pulling from one shared queue. Sized to keep the server-side
// MusicBrainz lock busy without piling up requests that can only be denied:
// a lookup holds that lock for 1-2 intervals, so a couple of workers
// saturate it and anything beyond that just burns serverless invocations on
// throttled responses.
//
// 2 is measured, not guessed. A 242-artist cold run at 4 never once had 4
// lookups in flight (peak 3, mean 1.37 while busy) and cost 3.4 throttle
// denials per lookup against 0.8 for the old sequential loop — the extra
// workers only bought denied requests. The floor is ~1500ms/artist: a
// typical lookup's work takes ~500ms but holds the lock for at least
// GEOCODE_MIN_INTERVAL_MS, so the quiet after it is the 1 req/s budget
// being honored, not slack that more concurrency can fill.
const DEFAULT_RESOLUTION_CONCURRENCY = 2;

// Vite substitutes import.meta.env.VITE_* at BUILD time — this is a baked-in
// constant, not a runtime lookup, so retuning it needs a redeploy rather than
// just an env change. Anything unset or nonsensical falls back to the
// measured default rather than failing the whole resolution loop.
export function parseConcurrency(
  raw,
  fallback = DEFAULT_RESOLUTION_CONCURRENCY,
) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const RESOLUTION_CONCURRENCY = parseConcurrency(
  import.meta.env?.VITE_RESOLUTION_CONCURRENCY,
);

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

// Resolution loop: RESOLUTION_CONCURRENCY workers pulling artists off one
// shared queue. Runs at app boot (keyed on token) regardless of whether
// explore mode is visible, so the map has clustered markers ready by the
// time the user opens it.
export function useLibraryArtists(token) {
  const [artists, setArtists] = useState([]);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [scopeMissing, setScopeMissing] = useState(false);
  // Artists whose /api/geocode call failed for backend/network reasons
  // (see resolveArtist below) — tracked separately from resolvedCount so a
  // failure is never indistinguishable from a legitimate not_found.
  const [failedCount, setFailedCount] = useState(0);
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
    // One controller per effect run (i.e. per token), shared by every worker.
    // Its cleanup aborts every /api/geocode request in flight and cancels any
    // pending throttled-retry timer, so a token change (e.g. the routine
    // TOKEN_EXPIRED refresh in MapView.jsx) can never leave a stale request
    // racing the new loop's — nothing from the old token survives it.
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
          // Non-200 (e.g. a raw 500 — api/geocode.js wraps its own Redis
          // calls and declares this as {status: "unavailable"}, but a
          // network hop between us and Vercel can still surface as some
          // other non-200, or 401/400/405) is treated as a resolution
          // failure for this artist rather than retried: retrying an outage
          // would spin the loop hot, and this artist isn't special. It is
          // NOT treated as "not_found" though — that's a legitimate
          // negative result from MusicBrainz/Nominatim, and this isn't one
          // (see the "unavailable" handling below). Only "throttled" (a 200
          // response) retries, since that's the server explicitly asking us
          // to wait, with a bounded backoff it names itself.
          result = response.ok
            ? await response.json()
            : { status: "unavailable" };
        } catch {
          // Covers both a genuine network failure (treated like a non-200
          // above) and this request being aborted by cleanup on a token
          // change — the isLive() check right below discards `result` in
          // the abort case, so it never gets marked unavailable or counted.
          result = { status: "unavailable" };
        }

        if (!isLive()) return;

        if (result.status === "throttled") {
          try {
            await delay(
              result.retryAfterMs + Math.random() * RETRY_JITTER_MS,
              controller.signal,
            );
          } catch {
            return; // aborted while waiting to retry — loop is dead, stop
          }
          continue;
        }

        if (result.status === "unavailable") {
          // A backend/network failure, not a legitimate negative result.
          // Deliberately NOT counted in resolvedCount (see failedCount's
          // declaration) so an outage can never make the library look
          // "fully resolved" — LibraryLoadingBadge stays visible instead of
          // hiding on a false "done". Also deliberately NOT retried here
          // (that would spin the loop hot on a real outage); it simply
          // moves on, same as the rest of this loop's failure handling.
          updateArtist(artist.id, { status: "unavailable" });
          if (isLive()) setFailedCount((c) => c + 1);
          return;
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
      setFailedCount(0);

      // One shared queue, N workers. `shift()` needs no lock: JavaScript is
      // single-threaded and there is no await between the shift and the
      // check, so two workers can never take the same artist.
      const queue = [...initial];
      await Promise.all(
        Array.from({ length: RESOLUTION_CONCURRENCY }, async () => {
          while (isLive()) {
            const artist = queue.shift();
            if (!artist) return;
            await resolveArtist(artist);
          }
        }),
      );
    }

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token]);

  return { artists, resolvedCount, total, scopeMissing, failedCount };
}
