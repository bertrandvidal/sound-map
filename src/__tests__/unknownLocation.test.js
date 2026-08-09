import { describe, expect, it } from "vitest";
import { UNKNOWN_LOCATION } from "../unknownLocation.js";

describe("UNKNOWN_LOCATION", () => {
  it("sits in the empty Pacific, far from any real artist origin", () => {
    expect(UNKNOWN_LOCATION.lat).toBe(0);
    expect(UNKNOWN_LOCATION.lng).toBe(-160);
  });

  it("is labelled so a marker reads as a placeholder, not a place", () => {
    expect(UNKNOWN_LOCATION.placeName).toBe("Unknown location");
  });

  // LeafletMap.zoomForLocation keys its fly-out zoom off this flag; without
  // it the map frames empty ocean at ARTIST_ZOOM and reads as broken.
  it("carries the `unknown` flag consumers key their zoom off", () => {
    expect(UNKNOWN_LOCATION.unknown).toBe(true);
  });

  // ArtistClusterLayer spreads this onto artist objects; a shared mutable
  // literal would let one consumer's edit leak into every other marker.
  it("cannot be mutated by a consumer", () => {
    expect(Object.isFrozen(UNKNOWN_LOCATION)).toBe(true);
  });
});
