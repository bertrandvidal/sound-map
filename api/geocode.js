import { COOKIE_NAME, openSession, parseCookies } from "../server/auth.js";
import { lookupArtistLocation } from "../server/geocode.js";
import {
  createRedisClient,
  getCachedArtist,
  setCachedArtist,
  tryAcquireThrottle,
} from "../server/kv.js";

export async function geocodeHandler(req, res, deps = {}) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Actually validate the session rather than just checking the `rt`
  // cookie is present: openSession decrypts and verifies it (shape +
  // 30-day lifetime), throwing on anything forged/tampered/expired. Without
  // this, any party holding a garbage `rt=x` cookie could hit this endpoint
  // as an open, unauthenticated proxy in front of the shared, rate-limited
  // MusicBrainz/Nominatim lookups below. Only the "is this real" fact is
  // needed here — the decrypted refresh token itself is discarded.
  try {
    openSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  } catch {
    return res.status(401).json({ error: "no_session" });
  }

  const { artistId, artistName } = req.body ?? {};
  if (!artistId || !artistName) {
    return res.status(400).json({ error: "invalid_request" });
  }

  // Resolved only once the request has cleared every guard above, so a
  // rejected request never pays for constructing a real Redis client.
  const redis = deps.redis ?? createRedisClient();
  const lookup = deps.lookupArtistLocation ?? lookupArtistLocation;
  const minIntervalMs = Number(process.env.GEOCODE_MIN_INTERVAL_MS ?? 1100);

  // Every Redis call below (cache read, throttle locks, cache write) can
  // throw on an Upstash outage. Uncaught, that surfaces as a raw 500 —
  // indistinguishable, to the client, from any other failure — and
  // useLibraryArtists.js (reasonably) treats a non-200 as "this artist has
  // no location" (see its comment). Across an entire outage that marks
  // every artist not_found, so the loop finishes and the library reads as
  // "resolved successfully, and it's empty." Catching here and returning a
  // declared status keeps the failure in-vocabulary and lets the client
  // tell it apart from a legitimate negative result.
  try {
    const cached = await getCachedArtist(redis, artistId);
    if (cached) return res.status(200).json(cached);

    if (!(await tryAcquireThrottle(redis, "musicbrainz", minIntervalMs))) {
      return res
        .status(200)
        .json({ status: "throttled", retryAfterMs: minIntervalMs });
    }

    // lookup() does both the MusicBrainz and (if needed) Nominatim calls
    // internally; a Nominatim-side throttle is acquired inside it.
    const location = await lookup(artistName, {
      acquireNominatimThrottle: () =>
        tryAcquireThrottle(redis, "nominatim", minIntervalMs),
    });
    if (location === "THROTTLED") {
      return res
        .status(200)
        .json({ status: "throttled", retryAfterMs: minIntervalMs });
    }

    const value = location
      ? { status: "resolved", ...location, resolvedAt: Date.now() }
      : { status: "not_found", resolvedAt: Date.now() };
    await setCachedArtist(redis, artistId, value);
    return res.status(200).json(value);
  } catch (err) {
    console.error("geocodeHandler: Redis failure", err);
    return res.status(200).json({ status: "unavailable" });
  }
}

export default function handler(req, res) {
  return geocodeHandler(req, res);
}
