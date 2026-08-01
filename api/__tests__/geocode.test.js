import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeHandler } from "../geocode.js";

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

function mockReq({ method = "POST", cookie = "rt=sealed-value", body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  return { method, headers, body };
}

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
      undefined,
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
