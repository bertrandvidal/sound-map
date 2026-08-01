import { COOKIE_NAME, parseCookies } from "../server/auth.js";
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

  if (!parseCookies(req.headers.cookie)[COOKIE_NAME]) {
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
}

export default function handler(req, res) {
  return geocodeHandler(req, res);
}
