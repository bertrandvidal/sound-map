import { describe, expect, it } from "vitest";
import { UNKNOWN_LOCATION } from "../../unknownLocation.js";
import { mappableArtists } from "../ArtistClusterLayer.jsx";

const resolved = {
  id: "1",
  name: "Nirvana",
  status: "resolved",
  lat: 46.97,
  lng: -123.81,
  placeName: "Aberdeen, Washington",
};
const notFound = { id: "2", name: "Boris", status: "not_found" };

describe("mappableArtists", () => {
  it("keeps a resolved artist at its own location, untouched", () => {
    expect(mappableArtists([resolved])).toEqual([resolved]);
  });

  it("places a not_found artist at the shared unknown-location placeholder", () => {
    const [artist] = mappableArtists([notFound]);
    expect(artist.lat).toBe(UNKNOWN_LOCATION.lat);
    expect(artist.lng).toBe(UNKNOWN_LOCATION.lng);
    expect(artist.unknown).toBe(true);
  });

  // ArtistMarker renders `📍 {artist.placeName}` in its tooltip, so this is
  // what makes the marker explain itself rather than claim a real place.
  it("labels a not_found artist so the tooltip explains itself", () => {
    expect(mappableArtists([notFound])[0].placeName).toBe("Unknown location");
  });

  it("keeps the artist's own identity when adding the placeholder", () => {
    const [artist] = mappableArtists([notFound]);
    expect(artist.id).toBe("2");
    expect(artist.name).toBe("Boris");
  });

  // The reason this fix lives on the client: geo:<artistId> entries cached as
  // not_found are returned verbatim by /api/geocode, so they reach us as
  // exactly this status and must map with no cache invalidation.
  it("maps a not_found result that came back from the geocode cache", () => {
    const cached = { ...notFound, resolvedAt: 1 };
    expect(mappableArtists([cached])[0].lng).toBe(UNKNOWN_LOCATION.lng);
  });

  // An /api/geocode failure means "no answer yet", not "no known origin".
  // Mapping it would make an outage render as a confident, complete answer —
  // the exact bug useLibraryArtists' failedCount exists to prevent.
  it("leaves an artist whose lookup failed off the map entirely", () => {
    expect(mappableArtists([{ id: "3", status: "unavailable" }])).toEqual([]);
  });

  it("leaves an artist still in the queue off the map", () => {
    expect(mappableArtists([{ id: "4", status: "pending" }])).toEqual([]);
  });

  it("maps a mixed library without reordering it", () => {
    const mixed = [notFound, { id: "5", status: "pending" }, resolved];
    expect(mappableArtists(mixed).map((a) => a.id)).toEqual(["2", "1"]);
  });

  it("does not mutate the artists it is given", () => {
    const input = { ...notFound };
    mappableArtists([input]);
    expect(input).toEqual(notFound);
  });

  it("handles a library that has not loaded yet", () => {
    expect(mappableArtists(undefined)).toEqual([]);
    expect(mappableArtists(null)).toEqual([]);
  });
});
