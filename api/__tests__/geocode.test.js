import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealSession } from "../../server/auth.js";

// Backs the `deps.redis ?? createRedisClient()` / `deps.lookupArtistLocation
// ?? lookupArtistLocation` fallbacks (see the "default deps" describe block
// below) without ever touching real Redis or the network.
const fakeRedisPipeline = {
  hincrby: vi.fn(function () {
    return this;
  }),
  lpush: vi.fn(function () {
    return this;
  }),
  ltrim: vi.fn(function () {
    return this;
  }),
  exec: vi.fn().mockResolvedValue([]),
};
const fakeRedisInstance = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue("OK"),
  pttl: vi.fn().mockResolvedValue(0),
  eval: vi.fn().mockResolvedValue(1),
  pipeline: vi.fn(() => fakeRedisPipeline),
};
const createRedisClientMock = vi.fn(() => fakeRedisInstance);
vi.mock("../../server/kv.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createRedisClient: () => createRedisClientMock() };
});

const defaultLookupMock = vi.fn().mockResolvedValue(null);
vi.mock("../../shared/geocode.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    lookupArtistLocation: (...args) => defaultLookupMock(...args),
  };
});

const { geocodeHandler } = await import("../geocode.js");

const DAY_MS = 24 * 60 * 60 * 1000;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// Defaults to a real, validly-sealed session cookie so every test below is
// exercising the actual crypto path, not a stand-in. Individual tests that
// care about the auth guard itself override `cookie`.
function mockReq({
  method = "POST",
  cookie = `rt=${sealSession("refresh-abc")}`,
  body,
} = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  return { method, headers, body };
}

// Every geocode path now touches Redis for metrics (a pipeline) and may hand
// back the tail of its lock (an eval). Tests build their redis from this so a
// missing method can't quietly send the handler down a swallowed-error path
// while the assertions still pass.
function mockRedis(overrides = {}) {
  const pipeline = {};
  Object.assign(pipeline, {
    hincrby: vi.fn(() => pipeline),
    lpush: vi.fn(() => pipeline),
    ltrim: vi.fn(() => pipeline),
    exec: vi.fn().mockResolvedValue([]),
  });
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    pttl: vi.fn().mockResolvedValue(0),
    eval: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn(() => pipeline),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/geocode", () => {
  it("rejects non-POST requests with 405", async () => {
    const res = mockRes();
    await geocodeHandler(mockReq({ method: "GET" }), res, {});
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "method_not_allowed" });
  });

  it("returns 401 no_session without a session cookie", async () => {
    const res = mockRes();
    await geocodeHandler(
      mockReq({ cookie: null, body: { artistId: "1", artistName: "A" } }),
      res,
      {},
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns 401 no_session for a forged/garbage cookie value, without touching Redis or the lookup", async () => {
    // Regression test for the security finding: api/geocode.js used to only
    // check that an `rt` cookie was present, never decrypting it — so any
    // party holding `rt=x` could use this endpoint as an open, unauthenticated
    // proxy in front of the shared MusicBrainz/Nominatim rate limits. This
    // must now be rejected before Redis (or the lookup) is ever touched.
    const redis = mockRedis({ get: vi.fn(), set: vi.fn() });
    const lookup = vi.fn();
    const res = mockRes();

    await geocodeHandler(
      mockReq({
        cookie: "rt=x",
        body: { artistId: "artist-1", artistName: "Test" },
      }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 401 no_session for a session sealed more than 30 days ago", async () => {
    const redis = mockRedis({ get: vi.fn(), set: vi.fn() });
    const lookup = vi.fn();
    const res = mockRes();
    const expired = sealSession("refresh-abc", Date.now() - 31 * DAY_MS);

    await geocodeHandler(
      mockReq({
        cookie: `rt=${expired}`,
        body: { artistId: "artist-1", artistName: "Test" },
      }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
    expect(redis.get).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_request when artistId is missing", async () => {
    const res = mockRes();
    await geocodeHandler(mockReq({ body: { artistName: "A" } }), res, {});
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
  });

  it("returns 400 invalid_request when artistName is missing", async () => {
    const res = mockRes();
    await geocodeHandler(mockReq({ body: { artistId: "1" } }), res, {});
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
  });

  it("returns 400 invalid_request when the body is entirely absent", async () => {
    const res = mockRes();
    await geocodeHandler(mockReq({ body: undefined }), res, {});
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
  });

  it("returns a cached resolved entry without calling lookup or the throttle", async () => {
    const cached = { status: "resolved", lat: 1, lng: 2, placeName: "Here" };
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(cached),
      set: vi.fn(),
    });
    const lookup = vi.fn();
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(cached);
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns a cached not_found entry without calling lookup or the throttle", async () => {
    const cached = { status: "not_found" };
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(cached),
      set: vi.fn(),
    });
    const lookup = vi.fn();
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(cached);
    expect(redis.set).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns throttled when the MusicBrainz lock cannot be acquired, and tells the client the lock's real remaining time", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(null), // lock already held elsewhere
      pttl: vi.fn().mockResolvedValue(640), // ...with 640ms left on it
    });
    const lookup = vi.fn();
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    // Not the 2200ms hold: sleeping a full hold when only 640ms remains
    // leaves the lock idle for the difference on every denial.
    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 640 });
    expect(redis.pttl).toHaveBeenCalledWith("throttle:musicbrainz");
    expect(lookup).not.toHaveBeenCalled();
    // The MusicBrainz lock is still *held* for two intervals: a lookup can
    // spend two MusicBrainz requests back-to-back (artist search, then the
    // area-parent lookup that disambiguates a city name).
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      "throttle:musicbrainz",
      expect.any(String),
      {
        nx: true,
        px: 2200,
      },
    );
  });

  it("falls back to the full hold when PTTL cannot answer", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(null),
      pttl: vi.fn().mockRejectedValue(new Error("upstash down")),
    });
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: vi.fn() },
    );

    // Degrades to the old constant rather than to "unavailable" — a failed
    // retry *hint* is not a failed request.
    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 2200 });
  });

  it("honors an explicit GEOCODE_MIN_INTERVAL_MS override in the throttled response", async () => {
    vi.stubEnv("GEOCODE_MIN_INTERVAL_MS", "500");
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(null),
      pttl: vi.fn().mockResolvedValue(-2), // freed between the SET and the PTTL
    });
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: vi.fn() },
    );

    // Already free — come straight back and let SET NX arbitrate.
    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 0 });
    expect(redis.set).toHaveBeenCalledWith(
      "throttle:musicbrainz",
      expect.any(String),
      {
        nx: true,
        px: 1000,
      },
    );
  });

  it("caches and returns not_found when the lookup finds no location", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    });
    const lookup = vi.fn().mockResolvedValue(null);
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(lookup).toHaveBeenCalledWith(
      "Test",
      expect.objectContaining({
        acquireNominatimThrottle: expect.any(Function),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "not_found",
        resolvedAt: expect.any(Number),
      }),
    );
    expect(redis.set).toHaveBeenLastCalledWith(
      "geo:artist-1",
      expect.objectContaining({ status: "not_found" }),
      { ex: 2592000 }, // not_found entries carry a 30-day TTL (see server/kv.js)
    );
  });

  it("returns throttled when the lookup reports a Nominatim-side throttle denial", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi
        .fn()
        .mockResolvedValueOnce("OK") // musicbrainz throttle granted
        .mockResolvedValueOnce(null), // nominatim throttle denied (2nd lock)
      pttl: vi.fn().mockResolvedValue(310),
    });
    const lookup = vi.fn(async (_artistName, { acquireNominatimThrottle }) => {
      const granted = await acquireNominatimThrottle();
      return granted ? { lat: 1, lng: 2, placeName: "X" } : "THROTTLED";
    });
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    // The retry hint must come from the lock that actually denied us — the
    // Nominatim one — not from the MusicBrainz lock this request holds.
    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 310 });
    expect(redis.pttl).toHaveBeenCalledWith("throttle:nominatim");
    // Both the musicbrainz and nominatim locks were attempted; no cache write.
    expect(redis.set).toHaveBeenCalledTimes(2);
    // Regression guard: the two locks must use distinct keys. A refactor that
    // collapsed both throttles onto "throttle:musicbrainz" would still pass
    // the call-count assertion above while silently doubling the rate at
    // which we hit both upstreams.
    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      "throttle:musicbrainz",
      expect.any(String),
      {
        nx: true,
        px: 2200, // two intervals: artist search + area-parent lookup
      },
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      "throttle:nominatim",
      expect.any(String),
      {
        nx: true,
        px: 1100,
      },
    );
  });

  it("hands the lookup an areaCache wired to the geo:area: keys", async () => {
    const redis = mockRedis({
      get: vi
        .fn()
        .mockResolvedValueOnce(null) // artist cache miss
        .mockResolvedValueOnce("Grays Harbor County"), // area cache hit
      set: vi.fn().mockResolvedValue("OK"),
    });
    const lookup = vi.fn(async (_artistName, { areaCache }) => {
      expect(await areaCache.get("aberdeen-area-id")).toBe(
        "Grays Harbor County",
      );
      await areaCache.set("other-area-id", "Some County");
      return { lat: 1, lng: 2, placeName: "X" };
    });

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Nirvana" } }),
      mockRes(),
      { redis, lookupArtistLocation: lookup },
    );

    expect(redis.get).toHaveBeenCalledWith("geo:area:aberdeen-area-id");
    expect(redis.set).toHaveBeenCalledWith(
      "geo:area:other-area-id",
      "Some County",
      { ex: 15552000 },
    );
  });

  it("caches and returns a resolved location on the full success path", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    });
    const location = { lat: 33.8958, lng: -118.2201, placeName: "Compton" };
    const lookup = vi.fn().mockResolvedValue(location);
    const res = mockRes();

    await geocodeHandler(
      mockReq({
        body: { artistId: "artist-1", artistName: "Kendrick Lamar" },
      }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "resolved",
        ...location,
        resolvedAt: expect.any(Number),
      }),
    );
    expect(redis.set).toHaveBeenLastCalledWith(
      "geo:artist-1",
      expect.objectContaining({ status: "resolved", ...location }),
      { ex: 15552000 }, // resolved entries carry a 180-day TTL (see server/kv.js)
    );
  });
});

describe("POST /api/geocode — handing back an unused lock reservation", () => {
  // A lookup that never consulted the area cache (or found it warm) spent
  // only one MusicBrainz call, so the second reserved interval is unowed.
  const oneCallLookup = vi.fn().mockResolvedValue({
    lat: 1,
    lng: 2,
    placeName: "X",
  });

  it("shortens the MusicBrainz lock to the airtime actually owed", async () => {
    const redis = mockRedis();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      mockRes(),
      { redis, lookupArtistLocation: oneCallLookup },
    );

    expect(redis.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = redis.eval.mock.calls[0];
    expect(script).toContain("pexpire");
    expect(keys).toEqual(["throttle:musicbrainz"]);
    // Fenced by the token this request holds, and never handing back more
    // than is owed: one call still owes a full interval from acquisition.
    const [token, remainingMs] = args;
    expect(redis.set).toHaveBeenCalledWith(
      "throttle:musicbrainz",
      token,
      expect.anything(),
    );
    expect(Number(remainingMs)).toBeGreaterThan(0);
    expect(Number(remainingMs)).toBeLessThanOrEqual(1100);
  });

  it("keeps the full reservation when the area cache missed (two calls spent)", async () => {
    const redis = mockRedis({
      // artist cache miss, then area cache miss
      get: vi.fn().mockResolvedValue(null),
    });
    const twoCallLookup = vi.fn(async (_name, { areaCache }) => {
      await areaCache.get("aberdeen-area-id"); // miss -> second MB call
      return { lat: 1, lng: 2, placeName: "X" };
    });

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Nirvana" } }),
      mockRes(),
      { redis, lookupArtistLocation: twoCallLookup },
    );

    // Both intervals were genuinely used, so nothing is given back.
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("gives the lock back even when the lookup found nothing", async () => {
    const redis = mockRedis();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Nobody" } }),
      mockRes(),
      { redis, lookupArtistLocation: vi.fn().mockResolvedValue(null) },
    );

    // A not_found still only cost one MusicBrainz call — holding the second
    // interval would penalise exactly the cheapest lookups.
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/geocode — metrics", () => {
  function metricsFrom(redis) {
    const pipeline = redis.pipeline.mock.results[0].value;
    return {
      counters: Object.fromEntries(
        pipeline.hincrby.mock.calls.map(([, field, amount]) => [field, amount]),
      ),
      samples: pipeline.lpush.mock.calls.map(([, json]) => JSON.parse(json)),
    };
  }

  it("records duration, upstream time and call count for a resolved lookup", async () => {
    const redis = mockRedis();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Nirvana" } }),
      mockRes(),
      {
        redis,
        // Takes real time, so the duration counters are non-zero — a 0
        // increment is skipped, since adding it to a running total is a no-op.
        lookupArtistLocation: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { lat: 1, lng: 2, placeName: "X" };
        }),
      },
    );

    const { counters, samples } = metricsFrom(redis);
    expect(counters).toEqual(
      expect.objectContaining({
        count: 1,
        resolved: 1,
        musicBrainzCalls: 1,
        totalMs: expect.any(Number),
        totalUpstreamMs: expect.any(Number),
      }),
    );
    expect(counters.totalMs).toBeGreaterThan(0);
    expect(counters.totalUpstreamMs).toBeGreaterThan(0);
    // `at` is what makes cadence recoverable from the sample list — the
    // gap between consecutive lookups is the number this work targets.
    expect(samples[0]).toEqual(
      expect.objectContaining({
        artist: "Nirvana",
        outcome: "resolved",
        musicBrainzCalls: 1,
        at: expect.any(Number),
        ms: expect.any(Number),
      }),
    );
  });

  it("counts an artist-cache hit without adding it to the sample list", async () => {
    const cached = { status: "resolved", lat: 1, lng: 2, placeName: "Here" };
    const redis = mockRedis({ get: vi.fn().mockResolvedValue(cached) });

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      mockRes(),
      { redis, lookupArtistLocation: vi.fn() },
    );

    const { counters, samples } = metricsFrom(redis);
    expect(counters).toEqual({ cacheHits: 1 });
    // Cache hits are the high-frequency case; sampling them would push real
    // lookups out of the capped list.
    expect(samples).toEqual([]);
  });

  it("counts a throttle denial", async () => {
    const redis = mockRedis({ set: vi.fn().mockResolvedValue(null) });

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      mockRes(),
      { redis, lookupArtistLocation: vi.fn() },
    );

    expect(metricsFrom(redis).counters).toEqual({ throttledMusicBrainz: 1 });
  });

  it("still answers the request when metrics recording blows up", async () => {
    const redis = mockRedis({
      pipeline: vi.fn(() => {
        throw new Error("upstash down");
      }),
    });
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      {
        redis,
        lookupArtistLocation: vi
          .fn()
          .mockResolvedValue({ lat: 1, lng: 2, placeName: "X" }),
      },
    );

    // Measurement must never be able to fail a lookup.
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: "resolved" }));
  });
});

describe("POST /api/geocode — Redis outage handling", () => {
  it("returns a declared unavailable response instead of throwing when the cache read fails", async () => {
    const redis = mockRedis({
      get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      set: vi.fn(),
    });
    const lookup = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "unavailable" });
    expect(lookup).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("returns a declared unavailable response instead of throwing when acquiring the throttle lock fails", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const lookup = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "unavailable" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns a declared unavailable response instead of throwing when caching the result fails", async () => {
    const redis = mockRedis({
      get: vi.fn().mockResolvedValue(null),
      set: vi
        .fn()
        .mockResolvedValueOnce("OK") // musicbrainz throttle granted
        .mockRejectedValueOnce(new Error("ECONNREFUSED")), // final cache write
    });
    const lookup = vi.fn().mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "unavailable" });
  });
});

describe("POST /api/geocode — default deps", () => {
  beforeEach(() => {
    createRedisClientMock.mockClear();
    defaultLookupMock.mockClear();
    fakeRedisInstance.get.mockClear().mockResolvedValue(null);
    fakeRedisInstance.set.mockClear().mockResolvedValue("OK");
  });

  it("falls back to createRedisClient() and the real lookupArtistLocation when deps are omitted", async () => {
    defaultLookupMock.mockResolvedValueOnce({
      lat: 1,
      lng: 2,
      placeName: "Somewhere",
    });
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      {}, // no redis, no lookupArtistLocation override
    );

    expect(createRedisClientMock).toHaveBeenCalledTimes(1);
    expect(defaultLookupMock).toHaveBeenCalledWith(
      "Test",
      expect.objectContaining({
        acquireNominatimThrottle: expect.any(Function),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ status: "resolved", placeName: "Somewhere" }),
    );
  });
});

describe("api/geocode default export", () => {
  it("delegates to geocodeHandler, short-circuiting before touching real deps for a non-POST request", async () => {
    const res = mockRes();
    const { default: handler } = await import("../geocode.js");
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "method_not_allowed" });
  });
});
