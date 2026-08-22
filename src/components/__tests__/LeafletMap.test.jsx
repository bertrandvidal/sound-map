import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LeafletMap, {
  ARTIST_ZOOM,
  UNKNOWN_ZOOM,
  zoomForLocation,
} from "../LeafletMap.jsx";

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

describe("dark tiles toggle", () => {
  function renderMap(darkMode) {
    return render(
      <LeafletMap
        track={null}
        location={null}
        exploreMode={false}
        libraryArtists={[]}
        onSelectArtist={vi.fn()}
        darkMode={darkMode}
      />,
    );
  }

  it("applies the dark-tiles class to the map container when darkMode is true", () => {
    const { container } = renderMap(true);
    expect(
      container
        .querySelector(".leaflet-container")
        ?.classList.contains("dark-tiles"),
    ).toBe(true);
  });

  it("does not apply the dark-tiles class when darkMode is false", () => {
    const { container } = renderMap(false);
    expect(
      container
        .querySelector(".leaflet-container")
        ?.classList.contains("dark-tiles"),
    ).toBe(false);
  });
});
