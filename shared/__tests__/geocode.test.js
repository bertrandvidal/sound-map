import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countryCodeFor,
  formatPlaceName,
  lookupArtistLocation,
  parentAreaName,
  selectArea,
} from "../geocode.js";

// The real shape of a MusicBrainz artist search hit for Nirvana: a city-level
// begin-area with an id, plus the artist's ISO country code. This is the case
// the disambiguation exists for — a bare "Aberdeen" search resolves to
// Scotland, and "Aberdeen" + countrycodes=us resolves to South Dakota.
const NIRVANA = {
  name: "Nirvana",
  country: "US",
  area: { id: "us-area-id", type: "Country", name: "United States" },
  "begin-area": { id: "aberdeen-area-id", type: "City", name: "Aberdeen" },
};

const ABERDEEN_AREA_RELS = {
  name: "Aberdeen",
  relations: [
    {
      type: "part of",
      direction: "forward",
      area: { name: "Some Child Area", type: "City" },
    },
    {
      type: "part of",
      direction: "backward",
      area: { name: "Grays Harbor County", type: "County" },
    },
  ],
};

const ABERDEEN_WA_HIT = {
  lat: "46.9753710",
  lon: "-123.8157220",
  address: {
    town: "Aberdeen",
    county: "Grays Harbor County",
    state: "Washington",
    country: "United States",
  },
};

const okJson = (data) => ({ ok: true, json: () => Promise.resolve(data) });

describe("shared/geocode - lookupArtistLocation", () => {
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

describe("shared/geocode - lookupArtistLocation with acquireNominatimThrottle", () => {
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

describe("shared/geocode - area disambiguation helpers", () => {
  it("prefers begin-area over area", () => {
    expect(selectArea(NIRVANA).name).toBe("Aberdeen");
  });

  it("falls back to area when begin-area is absent", () => {
    expect(selectArea({ area: { name: "United States" } }).name).toBe(
      "United States",
    );
  });

  it("returns null when the artist has neither", () => {
    expect(selectArea({ name: "Test" })).toBeNull();
    expect(selectArea(null)).toBeNull();
  });

  it("lowercases the artist's ISO country code for Nominatim", () => {
    expect(countryCodeFor(NIRVANA, NIRVANA["begin-area"])).toBe("us");
  });

  it("falls back to the area's own ISO code when the artist has no country", () => {
    expect(
      countryCodeFor({}, { name: "France", "iso-3166-1-codes": ["FR"] }),
    ).toBe("fr");
  });

  it("returns null when no country is known anywhere", () => {
    expect(countryCodeFor({}, { name: "Somewhere" })).toBeNull();
  });

  it("reads the containing area from a backward 'part of' relation", () => {
    expect(parentAreaName(ABERDEEN_AREA_RELS)).toBe("Grays Harbor County");
  });

  it("returns null when an area has no containing relation", () => {
    expect(parentAreaName({ relations: [] })).toBeNull();
    expect(parentAreaName(undefined)).toBeNull();
  });

  it("appends the region to the place name", () => {
    expect(formatPlaceName("Aberdeen", ABERDEEN_WA_HIT.address)).toBe(
      "Aberdeen, Washington",
    );
  });

  it("uses the country when there is no state", () => {
    expect(formatPlaceName("Reykjavík", { country: "Iceland" })).toBe(
      "Reykjavík, Iceland",
    );
  });

  it("does not repeat the area name when the region is the same place", () => {
    expect(formatPlaceName("United States", { country: "United States" })).toBe(
      "United States",
    );
    expect(formatPlaceName("Aberdeen", undefined)).toBe("Aberdeen");
  });
});

describe("shared/geocode - disambiguating an ambiguous city name", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("qualifies the Nominatim search with the parent area and country so Aberdeen resolves to Washington, not Scotland", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce(okJson(ABERDEEN_AREA_RELS))
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupArtistLocation("Nirvana")).toEqual({
      lat: 46.975371,
      lng: -123.815722,
      placeName: "Aberdeen, Washington",
    });

    const [areaRelsUrl] = fetchMock.mock.calls[1];
    expect(areaRelsUrl).toContain("/area/aberdeen-area-id");
    expect(areaRelsUrl).toContain("inc=area-rels");

    const [nominatimUrl] = fetchMock.mock.calls[2];
    expect(nominatimUrl).toContain(
      `q=${encodeURIComponent("Aberdeen, Grays Harbor County")}`,
    );
    expect(nominatimUrl).toContain("countrycodes=us");
  });

  it("skips the extra MusicBrainz hop when the area is already a country", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          artists: [
            {
              name: "Test",
              country: "FR",
              area: { id: "fr-area-id", type: "Country", name: "France" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okJson([{ lat: "46.6", lon: "2.3", address: { country: "France" } }]),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupArtistLocation("Test")).toEqual({
      lat: 46.6,
      lng: 2.3,
      placeName: "France",
    });
    // Only the artist search and Nominatim — no area-relations request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("countrycodes=fr");
  });

  it("still resolves with the country filter alone when the parent-area lookup fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupArtistLocation("Nirvana")).toEqual({
      lat: 46.975371,
      lng: -123.815722,
      placeName: "Aberdeen, Washington",
    });
    // Degraded to the unqualified name, but still country-filtered.
    const [nominatimUrl] = fetchMock.mock.calls[2];
    expect(nominatimUrl).toContain("q=Aberdeen&");
    expect(nominatimUrl).toContain("countrycodes=us");
  });

  it("survives a thrown error inside the parent-area lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupArtistLocation("Nirvana")).toEqual({
      lat: 46.975371,
      lng: -123.815722,
      placeName: "Aberdeen, Washington",
    });
  });

  it("skips the parent-area request entirely on an areaCache hit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);
    const areaCache = {
      get: vi.fn().mockResolvedValue("Grays Harbor County"),
      set: vi.fn(),
    };

    expect(await lookupArtistLocation("Nirvana", { areaCache })).toEqual({
      lat: 46.975371,
      lng: -123.815722,
      placeName: "Aberdeen, Washington",
    });

    expect(areaCache.get).toHaveBeenCalledWith("aberdeen-area-id");
    // Artist search + Nominatim only — the area-relations hop was served
    // from cache, which is the entire point.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Nothing new to write on a hit.
    expect(areaCache.set).not.toHaveBeenCalled();
    // ...and the cached parent still qualifies the Nominatim query.
    expect(fetchMock.mock.calls[1][0]).toContain(
      `q=${encodeURIComponent("Aberdeen, Grays Harbor County")}`,
    );
  });

  it("populates the areaCache after a miss", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce(okJson(ABERDEEN_AREA_RELS))
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);
    const areaCache = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    await lookupArtistLocation("Nirvana", { areaCache });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(areaCache.set).toHaveBeenCalledWith(
      "aberdeen-area-id",
      "Grays Harbor County",
    );
  });

  it("does not cache a parent lookup that failed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);
    const areaCache = { get: vi.fn().mockResolvedValue(null), set: vi.fn() };

    await lookupArtistLocation("Nirvana", { areaCache });

    // Caching the null would pin a transient MusicBrainz outage into Redis
    // for 180 days, silently un-disambiguating every artist from that city.
    expect(areaCache.set).not.toHaveBeenCalled();
  });

  it("works without an areaCache (the browser passes none)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce(okJson(ABERDEEN_AREA_RELS))
      .mockResolvedValueOnce(okJson([ABERDEEN_WA_HIT]));
    vi.stubGlobal("fetch", fetchMock);

    expect(await lookupArtistLocation("Nirvana")).toEqual({
      lat: 46.975371,
      lng: -123.815722,
      placeName: "Aberdeen, Washington",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not consult the areaCache for a country-level area", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({
          artists: [
            {
              name: "Test",
              country: "FR",
              area: { id: "fr-area-id", type: "Country", name: "France" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okJson([{ lat: "46.6", lon: "2.3", address: { country: "France" } }]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const areaCache = { get: vi.fn(), set: vi.fn() };

    await lookupArtistLocation("Test", { areaCache });

    expect(areaCache.get).not.toHaveBeenCalled();
  });

  it("does not spend the Nominatim throttle slot until after the parent-area hop", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ artists: [NIRVANA] }))
      .mockResolvedValueOnce(okJson(ABERDEEN_AREA_RELS));
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupArtistLocation("Nirvana", {
      acquireNominatimThrottle: vi.fn().mockResolvedValue(false),
    });

    expect(result).toBe("THROTTLED");
    // Artist search + area relations happened; Nominatim never did.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
