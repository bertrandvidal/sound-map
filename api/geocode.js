import { COOKIE_NAME, openSession, parseCookies } from "../server/auth.js";
import {
  acquireThrottle,
  createRedisClient,
  getCachedAreaParent,
  getCachedArtist,
  getThrottleRetryMs,
  recordLookupMetrics,
  releaseThrottleAfter,
  setCachedAreaParent,
  setCachedArtist,
} from "../server/kv.js";
import {
  lookupArtistLocation,
  MUSICBRAINZ_CALLS_PER_LOOKUP,
} from "../shared/geocode.js";

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
  const startedAt = Date.now();
  try {
    const cached = await getCachedArtist(redis, artistId);
    if (cached) {
      await recordLookupMetrics(redis, { counters: { cacheHits: 1 } });
      return res.status(200).json(cached);
    }

    // Held for MUSICBRAINZ_CALLS_PER_LOOKUP intervals, not one: a lookup can
    // spend two MusicBrainz requests (artist search, then the area-parent
    // lookup that disambiguates "Aberdeen"), and they run back-to-back inside
    // lookup(). Reserving the airtime up front keeps the *average* rate inside
    // MusicBrainz's 1 req/s budget; trying to take a second slot mid-lookup
    // instead would just fail against the lock this one still holds, and the
    // client's retry would fail the same way forever. The tail of the
    // reservation is handed back below when the lookup turns out cheaper.
    const musicBrainzHoldMs = minIntervalMs * MUSICBRAINZ_CALLS_PER_LOOKUP;
    const lockToken = await acquireThrottle(
      redis,
      "musicbrainz",
      musicBrainzHoldMs,
    );
    const lockedAt = Date.now();
    if (!lockToken) {
      await recordLookupMetrics(redis, {
        counters: { throttledMusicBrainz: 1 },
      });
      // Retry when the lock actually frees, not after a fixed interval. A
      // constant here is wrong in both directions: too small burns a
      // round-trip on a lock that is still held, too large leaves it idle.
      return res.status(200).json({
        status: "throttled",
        retryAfterMs: await getThrottleRetryMs(
          redis,
          "musicbrainz",
          musicBrainzHoldMs,
        ),
      });
    }

    // Whether the second MusicBrainz call actually happened is derivable
    // right here, without lookup() having to report it: it is spent exactly
    // when the area cache is consulted and misses. Wrapping the cache we
    // already pass in keeps shared/geocode.js free of both Redis and metrics.
    let areaCacheMissed = false;
    let areaCacheHit = false;
    const areaCache = {
      get: async (areaId) => {
        const parentName = await getCachedAreaParent(redis, areaId);
        if (parentName) areaCacheHit = true;
        else areaCacheMissed = true;
        return parentName;
      },
      set: (areaId, parentName) =>
        setCachedAreaParent(redis, areaId, parentName),
    };

    // lookup() does both the MusicBrainz and (if needed) Nominatim calls
    // internally; a Nominatim-side throttle is acquired inside it.
    const upstreamStartedAt = Date.now();
    const location = await lookup(artistName, {
      acquireNominatimThrottle: async () =>
        Boolean(await acquireThrottle(redis, "nominatim", minIntervalMs)),
      areaCache,
    });
    const upstreamMs = Date.now() - upstreamStartedAt;

    // Only one MusicBrainz call was actually spent unless the area cache
    // missed, so give back the second interval — but only the part that is
    // genuinely unowed: the one call we did make still owes a full interval
    // from when the lock was taken.
    const musicBrainzCalls = areaCacheMissed ? 2 : 1;
    if (musicBrainzCalls === 1) {
      await releaseThrottleAfter(
        redis,
        "musicbrainz",
        lockToken,
        minIntervalMs - (Date.now() - lockedAt),
      );
    }

    const metricsFor = (outcome) => ({
      counters: {
        count: 1,
        totalMs: Date.now() - startedAt,
        totalUpstreamMs: upstreamMs,
        musicBrainzCalls,
        areaCacheHits: areaCacheHit ? 1 : 0,
        areaCacheMisses: areaCacheMissed ? 1 : 0,
        [outcome]: 1,
      },
      sample: {
        at: Date.now(),
        artist: artistName,
        ms: Date.now() - startedAt,
        upstreamMs,
        musicBrainzCalls,
        outcome,
      },
    });

    if (location === "THROTTLED") {
      await recordLookupMetrics(redis, { counters: { throttledNominatim: 1 } });
      return res.status(200).json({
        status: "throttled",
        retryAfterMs: await getThrottleRetryMs(
          redis,
          "nominatim",
          minIntervalMs,
        ),
      });
    }

    const value = location
      ? { status: "resolved", ...location, resolvedAt: Date.now() }
      : { status: "not_found", resolvedAt: Date.now() };
    await recordLookupMetrics(
      redis,
      metricsFor(location ? "resolved" : "notFound"),
    );
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
