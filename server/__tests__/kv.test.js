import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisConstructor = vi.fn(function FakeRedis() {});

vi.mock("@upstash/redis", () => ({
  Redis: redisConstructor,
}));

const {
  createRedisClient,
  getCachedAreaParent,
  getCachedArtist,
  getThrottleRetryMs,
  setCachedAreaParent,
  setCachedArtist,
  tryAcquireThrottle,
} = await import("../kv.js");

describe("createRedisClient", () => {
  beforeEach(() => {
    redisConstructor.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs a Redis client from the REDIS_-prefixed Vercel Upstash env vars", () => {
    vi.stubEnv("REDIS_KV_REST_API_URL", "https://example.upstash.io");
    vi.stubEnv("REDIS_KV_REST_API_TOKEN", "secret-token");

    const client = createRedisClient();

    expect(redisConstructor).toHaveBeenCalledWith({
      url: "https://example.upstash.io",
      token: "secret-token",
    });
    expect(client).toBeInstanceOf(redisConstructor);
  });
});

describe("getCachedArtist", () => {
  it("returns null on a cache miss", async () => {
    const redis = { get: vi.fn().mockResolvedValue(null) };

    const result = await getCachedArtist(redis, "artist-1");

    expect(result).toBeNull();
    expect(redis.get).toHaveBeenCalledWith("geo:artist-1");
  });

  it("returns the parsed value on a cache hit", async () => {
    const cached = { status: "resolved", lat: 1, lng: 2, placeName: "Here" };
    const redis = { get: vi.fn().mockResolvedValue(cached) };

    const result = await getCachedArtist(redis, "artist-1");

    expect(result).toEqual(cached);
  });
});

describe("setCachedArtist", () => {
  it("stores resolved entries with a 180-day TTL", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };
    const value = { status: "resolved", lat: 1, lng: 2, placeName: "Here" };

    await setCachedArtist(redis, "artist-1", value);

    // 180 days: a fuzzy MusicBrainz name match can be wrong, so a bad
    // location should eventually expire rather than being cached forever
    // (see server/geocode.js's no-disambiguation artist lookup).
    expect(redis.set).toHaveBeenCalledWith("geo:artist-1", value, {
      ex: 15552000,
    });
  });

  it("stores not_found entries with a 30-day TTL", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };
    const value = { status: "not_found" };

    await setCachedArtist(redis, "artist-1", value);

    expect(redis.set).toHaveBeenCalledWith("geo:artist-1", value, {
      ex: 2592000,
    });
  });
});

describe("tryAcquireThrottle", () => {
  it("returns true when the lock is acquired", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };

    const acquired = await tryAcquireThrottle(redis, "musicbrainz", 1000);

    expect(acquired).toBe(true);
    expect(redis.set).toHaveBeenCalledWith("throttle:musicbrainz", "1", {
      nx: true,
      px: 1000,
    });
  });

  it("returns false when the lock is already held", async () => {
    const redis = { set: vi.fn().mockResolvedValue(null) };

    const acquired = await tryAcquireThrottle(redis, "musicbrainz", 1000);

    expect(acquired).toBe(false);
  });
});

describe("getThrottleRetryMs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reports the lock's actual remaining lifetime", async () => {
    const redis = { pttl: vi.fn().mockResolvedValue(640) };

    expect(await getThrottleRetryMs(redis, "musicbrainz", 2200)).toBe(640);
    expect(redis.pttl).toHaveBeenCalledWith("throttle:musicbrainz");
  });

  it("says retry immediately when the key is already gone (PTTL -2)", async () => {
    const redis = { pttl: vi.fn().mockResolvedValue(-2) };

    expect(await getThrottleRetryMs(redis, "musicbrainz", 2200)).toBe(0);
  });

  it("says retry immediately when the key has no expiry (PTTL -1)", async () => {
    const redis = { pttl: vi.fn().mockResolvedValue(-1) };

    expect(await getThrottleRetryMs(redis, "nominatim", 1100)).toBe(0);
  });

  it("falls back to the caller's interval when PTTL itself fails", async () => {
    const redis = {
      pttl: vi.fn().mockRejectedValue(new Error("upstash down")),
    };

    expect(await getThrottleRetryMs(redis, "nominatim", 1100)).toBe(1100);
  });
});

describe("area parent cache", () => {
  it("returns null on a miss", async () => {
    const redis = { get: vi.fn().mockResolvedValue(null) };

    expect(await getCachedAreaParent(redis, "area-1")).toBeNull();
    expect(redis.get).toHaveBeenCalledWith("geo:area:area-1");
  });

  it("returns the containing area's name on a hit", async () => {
    const redis = { get: vi.fn().mockResolvedValue("Grays Harbor County") };

    expect(await getCachedAreaParent(redis, "area-1")).toBe(
      "Grays Harbor County",
    );
  });

  it("stores the parent under its own key, keyed by area rather than artist", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };

    await setCachedAreaParent(redis, "area-1", "Grays Harbor County");

    // Same 180-day TTL as a resolved artist. Area containment is a fact about
    // geography — it is shared by every artist from that city, which is the
    // whole point of caching it separately from `geo:<artistId>`.
    expect(redis.set).toHaveBeenCalledWith(
      "geo:area:area-1",
      "Grays Harbor County",
      { ex: 15552000 },
    );
  });
});
