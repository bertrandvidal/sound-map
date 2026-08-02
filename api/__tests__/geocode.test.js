import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealSession } from "../../server/auth.js";
import { geocodeHandler } from "../geocode.js";

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
    const redis = { get: vi.fn(), set: vi.fn() };
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
    const redis = { get: vi.fn(), set: vi.fn() };
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
    const redis = { get: vi.fn().mockResolvedValue(cached), set: vi.fn() };
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
    const redis = { get: vi.fn().mockResolvedValue(cached), set: vi.fn() };
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

  it("returns throttled when the MusicBrainz lock cannot be acquired", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(null), // lock already held elsewhere
    };
    const lookup = vi.fn();
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: lookup },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 1100 });
    expect(lookup).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith("throttle:musicbrainz", "1", {
      nx: true,
      px: 1100,
    });
  });

  it("honors an explicit GEOCODE_MIN_INTERVAL_MS override in the throttled response", async () => {
    vi.stubEnv("GEOCODE_MIN_INTERVAL_MS", "500");
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(null),
    };
    const res = mockRes();

    await geocodeHandler(
      mockReq({ body: { artistId: "artist-1", artistName: "Test" } }),
      res,
      { redis, lookupArtistLocation: vi.fn() },
    );

    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 500 });
    expect(redis.set).toHaveBeenCalledWith("throttle:musicbrainz", "1", {
      nx: true,
      px: 500,
    });
  });

  it("caches and returns not_found when the lookup finds no location", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    };
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
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi
        .fn()
        .mockResolvedValueOnce("OK") // musicbrainz throttle granted
        .mockResolvedValueOnce(null), // nominatim throttle denied (2nd lock)
    };
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
    expect(res.body).toEqual({ status: "throttled", retryAfterMs: 1100 });
    // Both the musicbrainz and nominatim locks were attempted; no cache write.
    expect(redis.set).toHaveBeenCalledTimes(2);
    // Regression guard: the two locks must use distinct keys. A refactor that
    // collapsed both throttles onto "throttle:musicbrainz" would still pass
    // the call-count assertion above while silently doubling the rate at
    // which we hit both upstreams.
    expect(redis.set).toHaveBeenNthCalledWith(1, "throttle:musicbrainz", "1", {
      nx: true,
      px: 1100,
    });
    expect(redis.set).toHaveBeenNthCalledWith(2, "throttle:nominatim", "1", {
      nx: true,
      px: 1100,
    });
  });

  it("caches and returns a resolved location on the full success path", async () => {
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
    };
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

describe("POST /api/geocode — Redis outage handling", () => {
  it("returns a declared unavailable response instead of throwing when the cache read fails", async () => {
    const redis = {
      get: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      set: vi.fn(),
    };
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
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    };
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
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi
        .fn()
        .mockResolvedValueOnce("OK") // musicbrainz throttle granted
        .mockRejectedValueOnce(new Error("ECONNREFUSED")), // final cache write
    };
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

describe("api/geocode default export", () => {
  it("delegates to geocodeHandler, short-circuiting before touching real deps for a non-POST request", async () => {
    const res = mockRes();
    const { default: handler } = await import("../geocode.js");
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "method_not_allowed" });
  });
});
