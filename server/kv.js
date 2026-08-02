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
