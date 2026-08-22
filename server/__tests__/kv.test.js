import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisConstructor = vi.fn(function FakeRedis() {});

vi.mock("@upstash/redis", () => ({
  Redis: redisConstructor,
}));

const {
  acquireThrottle,
  createRedisClient,
  getCachedAreaParent,
  getCachedArtist,
  getThrottleRetryMs,
  recordLookupMetrics,
  releaseThrottleAfter,
  setCachedAreaParent,
  setCachedArtist,
} = await import("../kv.js");

// Records the calls queued on a pipeline and lets a test assert the order.
function mockPipeline() {
  const calls = [];
  const chain = {
    calls,
    hincrby: (...args) => {
      calls.push(["hincrby", ...args]);
      return chain;
    },
    lpush: (...args) => {
      calls.push(["lpush", ...args]);
      return chain;
    },
    ltrim: (...args) => {
      calls.push(["ltrim", ...args]);
      return chain;
    },
    exec: vi.fn().mockResolvedValue([]),
  };
  return chain;
}

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

describe("acquireThrottle", () => {
  it("returns a fencing token and stores it as the lock's value", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };

    const token = await acquireThrottle(redis, "musicbrainz", 1000);

    expect(token).toEqual(expect.any(String));
    expect(redis.set).toHaveBeenCalledWith("throttle:musicbrainz", token, {
      nx: true,
      px: 1000,
    });
  });

  it("gives every holder a distinct token", async () => {
    const redis = { set: vi.fn().mockResolvedValue("OK") };

    const first = await acquireThrottle(redis, "musicbrainz", 1000);
    const second = await acquireThrottle(redis, "musicbrainz", 1000);

    // Two holders sharing a token could shorten each other's lock, which is
    // exactly what the token exists to prevent.
    expect(first).not.toBe(second);
  });

  it("returns null when the lock is already held", async () => {
    const redis = { set: vi.fn().mockResolvedValue(null) };

    expect(await acquireThrottle(redis, "musicbrainz", 1000)).toBeNull();
  });
});

describe("releaseThrottleAfter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("shortens the lock to the airtime still owed, fenced by the token", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };

    const shortened = await releaseThrottleAfter(
      redis,
      "musicbrainz",
      "token-abc",
      400,
    );

    expect(shortened).toBe(true);
    const [script, keys, args] = redis.eval.mock.calls[0];
    expect(script).toContain("pexpire");
    expect(keys).toEqual(["throttle:musicbrainz"]);
    expect(args).toEqual(["token-abc", "400"]);
  });

  it("clamps a negative remainder to zero (the script then deletes)", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(1) };

    await releaseThrottleAfter(redis, "musicbrainz", "token-abc", -250);

    expect(redis.eval.mock.calls[0][2]).toEqual(["token-abc", "0"]);
  });

  it("does nothing without a token", async () => {
    const redis = { eval: vi.fn() };

    expect(await releaseThrottleAfter(redis, "musicbrainz", null, 400)).toBe(
      false,
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("reports failure when the lock is no longer ours", async () => {
    const redis = { eval: vi.fn().mockResolvedValue(0) };

    expect(
      await releaseThrottleAfter(redis, "musicbrainz", "stale-token", 400),
    ).toBe(false);
  });

  it("swallows a Redis failure — the lock just runs its original course", async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error("down")) };

    expect(
      await releaseThrottleAfter(redis, "musicbrainz", "token-abc", 400),
    ).toBe(false);
  });
});

describe("recordLookupMetrics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("increments counters and appends a capped sample in one pipeline", async () => {
    const pipeline = mockPipeline();
    const redis = { pipeline: () => pipeline };
    const sample = { at: 1000, artist: "Nirvana", ms: 900 };

    await recordLookupMetrics(redis, {
      counters: { count: 1, totalMs: 900 },
      sample,
    });

    expect(pipeline.calls).toEqual([
      ["hincrby", "metrics:geocode", "count", 1],
      ["hincrby", "metrics:geocode", "totalMs", 900],
      ["lpush", "metrics:geocode:recent", JSON.stringify(sample)],
      ["ltrim", "metrics:geocode:recent", 0, 499],
    ]);
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it("skips zero-valued counters so the hash stays readable", async () => {
    const pipeline = mockPipeline();

    await recordLookupMetrics(
      { pipeline: () => pipeline },
      { counters: { count: 1, areaCacheHits: 0 } },
    );

    expect(pipeline.calls).toEqual([
      ["hincrby", "metrics:geocode", "count", 1],
    ]);
  });

  it("never lets a metrics failure escape into the request", async () => {
    const redis = {
      pipeline: () => {
        throw new Error("upstash down");
      },
    };

    await expect(
      recordLookupMetrics(redis, { counters: { count: 1 } }),
    ).resolves.toBeUndefined();
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
