import { Redis } from "@upstash/redis";

const NOT_FOUND_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
// server/geocode.js picks mbData.artists[0] from a fuzzy, undisambiguated
// MusicBrainz name search, so a wrong match for a common artist name is
// expected occasionally. Without a TTL that bad location would be cached
// forever, fixable only by hand in the Upstash console. 180 days bounds the
// damage while still making the cache effective for its purpose.
const RESOLVED_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days

// The Vercel Marketplace Upstash integration injects credentials under a
// `REDIS_` prefix (`REDIS_KV_REST_API_URL` / `REDIS_KV_REST_API_TOKEN`), not
// either pair `Redis.fromEnv()` looks for (`UPSTASH_REDIS_REST_*` or
// `KV_REST_API_*`). Do not "simplify" this to `Redis.fromEnv()` — it will
// silently fail to authenticate in production. Uses the read-write token
// because the throttle lock does `SET NX PX`.
export const createRedisClient = () =>
  new Redis({
    url: process.env.REDIS_KV_REST_API_URL,
    token: process.env.REDIS_KV_REST_API_TOKEN,
  });

// Area containment ("Aberdeen is part of Grays Harbor County") is a fact about
// geography, not about an artist, so it outlives any one lookup and is shared
// across every artist from the same place — and artists cluster hard in a
// handful of cities. Cached for as long as a resolved artist; the underlying
// MusicBrainz relation effectively never changes.
const AREA_TTL_SECONDS = RESOLVED_TTL_SECONDS;

/** The containing area's name, or `null` on a miss. */
export async function getCachedAreaParent(redis, areaId) {
  const value = await redis.get(`geo:area:${areaId}`);
  return value ?? null;
}

export async function setCachedAreaParent(redis, areaId, parentName) {
  await redis.set(`geo:area:${areaId}`, parentName, { ex: AREA_TTL_SECONDS });
}

export async function getCachedArtist(redis, artistId) {
  const value = await redis.get(`geo:${artistId}`);
  return value ?? null;
}

export async function setCachedArtist(redis, artistId, value) {
  const ttlSeconds =
    value.status === "not_found" ? NOT_FOUND_TTL_SECONDS : RESOLVED_TTL_SECONDS;
  await redis.set(`geo:${artistId}`, value, { ex: ttlSeconds });
}

export async function tryAcquireThrottle(redis, service, minIntervalMs) {
  const result = await redis.set(`throttle:${service}`, "1", {
    nx: true,
    px: minIntervalMs,
  });
  return result !== null;
}

/**
 * How long a denied caller should wait before trying the lock again: the
 * lock's actual remaining lifetime.
 *
 * Answering with a constant (the full hold) systematically overshoots — a
 * caller denied halfway through someone else's hold sleeps for another full
 * hold, so the lock sits idle for the remainder of the first one. Since the
 * client sleeps exactly this long before retrying (useLibraryArtists.js),
 * handing back the real TTL is what keeps the upstream saturated instead of
 * duty-cycled.
 *
 * PTTL answers -2 when the key is already gone and -1 when it somehow has no
 * expiry; both mean "nothing useful to wait for", so retry immediately and
 * let SET NX arbitrate. The fallback covers a PTTL that fails outright.
 */
export async function getThrottleRetryMs(redis, service, fallbackMs) {
  try {
    const ttl = await redis.pttl(`throttle:${service}`);
    return ttl > 0 ? ttl : 0;
  } catch (err) {
    console.warn(`getThrottleRetryMs failed for ${service}:`, err.message);
    return fallbackMs;
  }
}
