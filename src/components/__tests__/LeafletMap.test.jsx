import { describe, expect, it } from "vitest";
import { ARTIST_ZOOM, UNKNOWN_ZOOM, zoomForLocation } from "../LeafletMap.jsx";

describe("zoomForLocation", () => {
  it("zooms in close on a resolved artist location", () => {
    expect(zoomForLocation({ lat: 47.1, lng: -123.8 })).toBe(ARTIST_ZOOM);
  });

  it("stays zoomed out for the unknown-location fallback", () => {
    expect(zoomForLocation({ lat: 0, lng: -160, unknown: true })).toBe(
      UNKNOWN_ZOOM,
    );
  });

  it("keeps the unknown zoom wide enough to show surrounding continents", () => {
    expect(UNKNOWN_ZOOM).toBeLessThan(ARTIST_ZOOM);
    expect(UNKNOWN_ZOOM).toBeLessThanOrEqual(3);
  });
});
