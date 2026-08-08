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

/**
 * Takes the lock, returning an opaque token on success and `null` when it is
 * already held.
 *
 * The token is what makes the lock safe to *modify* after the fact (see
 * `releaseThrottleAfter`). A lock whose value is a constant can only be taken
 * and waited out: any holder trying to shorten or extend it is really saying
 * "change whatever lock is there now", which silently mangles a *different*
 * holder's lock if the original lease lapsed mid-request.
 */
export async function acquireThrottle(redis, service, minIntervalMs) {
  const token = globalThis.crypto.randomUUID();
  const result = await redis.set(`throttle:${service}`, token, {
    nx: true,
    px: minIntervalMs,
  });
  return result !== null ? token : null;
}

// Compare-and-shorten, the fenced counterpart to acquireThrottle. Both
// branches first check that the lock still carries our token, so a lease that
// expired mid-request leaves someone else's lock untouched.
const SHORTEN_IF_OURS = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
if tonumber(ARGV[2]) <= 0 then return redis.call("del", KEYS[1]) end
return redis.call("pexpire", KEYS[1], tonumber(ARGV[2]))
`;

/**
 * Gives back the unused tail of a hold: the lock expires `remainingMs` from
 * now instead of whenever it was originally due, or is dropped outright when
 * that is already zero.
 *
 * Callers reserve for the worst case (two MusicBrainz calls) because they
 * cannot know the shape of a lookup before making it. Most lookups turn out
 * cheaper than that, and without this they would leave the upstream idle for
 * the difference. `remainingMs` is the airtime the calls actually made still
 * owe — never simply zero, or a lookup that finished in 300ms would let the
 * next one start immediately and blow the 1 req/s budget.
 *
 * Best-effort: a failure here just means the lock runs its original course.
 */
export async function releaseThrottleAfter(redis, service, token, remainingMs) {
  if (!token) return false;
  try {
    const result = await redis.eval(
      SHORTEN_IF_OURS,
      [`throttle:${service}`],
      [token, String(Math.max(0, Math.round(remainingMs)))],
    );
    return result === 1;
  } catch (err) {
    console.warn(`releaseThrottleAfter failed for ${service}:`, err.message);
    return false;
  }
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

export const METRICS_KEY = "metrics:geocode";
export const METRICS_RECENT_KEY = "metrics:geocode:recent";
// Enough to cover a full library resolution end to end while staying a
// bounded, cheap read in the Upstash console.
const METRICS_RECENT_MAX = 500;

/**
 * Records what a single /api/geocode request cost, for later inspection:
 *
 *   HGETALL metrics:geocode          -- running totals; average = totalMs/count
 *   LRANGE  metrics:geocode:recent 0 -1
 *
 * Samples carry `at`, so consecutive timestamps give the *cadence* (the thing
 * the throttle work is actually trying to improve), not just per-request
 * duration. Denials and artist-cache hits only bump counters — they are the
 * high-frequency cases and would otherwise crowd real lookups out of the
 * capped sample list.
 *
 * Everything runs in one pipelined round-trip, and failures are swallowed:
 * measurement must never be able to fail a request.
 */
export async function recordLookupMetrics(redis, { counters, sample } = {}) {
  try {
    const pipeline = redis.pipeline();
    for (const [field, amount] of Object.entries(counters ?? {})) {
      if (amount) pipeline.hincrby(METRICS_KEY, field, amount);
    }
    if (sample) {
      pipeline.lpush(METRICS_RECENT_KEY, JSON.stringify(sample));
      pipeline.ltrim(METRICS_RECENT_KEY, 0, METRICS_RECENT_MAX - 1);
    }
    await pipeline.exec();
  } catch (err) {
    console.warn("recordLookupMetrics failed:", err.message);
  }
}
