import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupArtistLocation } from "../geocode.js";

describe("server/geocode - lookupArtistLocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when MusicBrainz finds no artists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ artists: [] }),
      }),
    );
    expect(await lookupArtistLocation("Unknown Artist XYZ")).toBeNull();
  });

  it("returns null when artist has no begin-area or area", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ artists: [{ name: "Test" }] }),
      }),
    );
    expect(await lookupArtistLocation("Test")).toBeNull();
  });

  it("returns null when Nominatim finds no results for the area", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            artists: [{ name: "Test", "begin-area": { name: "Nowhere" } }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupArtistLocation("Test")).toBeNull();
  });

  it("returns lat/lng/placeName when both APIs succeed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            artists: [
              { name: "Kendrick Lamar", "begin-area": { name: "Compton" } },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ lat: "33.8958", lon: "-118.2201" }]),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupArtistLocation("Kendrick Lamar")).toEqual({
      lat: 33.8958,
      lng: -118.2201,
      placeName: "Compton",
    });
  });

  it("falls back to area.name when begin-area is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            artists: [{ name: "Test", area: { name: "London" } }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ lat: "51.5074", lon: "-0.1278" }]),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupArtistLocation("Test")).toEqual({
      lat: 51.5074,
      lng: -0.1278,
      placeName: "London",
    });
  });

  it("returns null when MusicBrainz returns an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );
    expect(await lookupArtistLocation("Test Artist")).toBeNull();
  });

  it("returns null when Nominatim returns an HTTP error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            artists: [{ name: "Test", "begin-area": { name: "Somewhere" } }],
          }),
      })
      .mockResolvedValueOnce({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupArtistLocation("Test Artist")).toBeNull();
  });
});

describe("server/geocode - lookupArtistLocation with acquireNominatimThrottle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls acquireNominatimThrottle right before the Nominatim request and proceeds when granted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            artists: [
              { name: "Kendrick Lamar", "begin-area": { name: "Compton" } },
            ],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ lat: "33.8958", lon: "-118.2201" }]),
      });
    vi.stubGlobal("fetch", fetchMock);
    const acquireNominatimThrottle = vi.fn().mockResolvedValue(true);

    const result = await lookupArtistLocation("Kendrick Lamar", {
      acquireNominatimThrottle,
    });

    expect(result).toEqual({
      lat: 33.8958,
      lng: -118.2201,
      placeName: "Compton",
    });
    expect(acquireNominatimThrottle).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns "THROTTLED" without calling Nominatim when acquireNominatimThrottle resolves false', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          artists: [{ name: "Test", "begin-area": { name: "Somewhere" } }],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const acquireNominatimThrottle = vi.fn().mockResolvedValue(false);

    const result = await lookupArtistLocation("Test", {
      acquireNominatimThrottle,
    });

    expect(result).toBe("THROTTLED");
    expect(acquireNominatimThrottle).toHaveBeenCalledTimes(1);
    // Only the MusicBrainz call happened; Nominatim was never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call acquireNominatimThrottle when MusicBrainz finds no area (never reaches the Nominatim step)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ artists: [{ name: "Test" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const acquireNominatimThrottle = vi.fn().mockResolvedValue(false);

    const result = await lookupArtistLocation("Test", {
      acquireNominatimThrottle,
    });

    expect(result).toBeNull();
    expect(acquireNominatimThrottle).not.toHaveBeenCalled();
  });

  it("behaves exactly as the one-argument call when options is an empty object", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            artists: [{ name: "Test", area: { name: "London" } }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ lat: "51.5074", lon: "-0.1278" }]),
      });
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupArtistLocation("Test", {})).toEqual({
      lat: 51.5074,
      lng: -0.1278,
      placeName: "London",
    });
  });
});
