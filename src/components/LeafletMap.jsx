import { useEffect, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./leafletDarkTiles.css";
import AlbumBubble from "./AlbumBubble.jsx";
import ArtistClusterLayer from "./ArtistClusterLayer.jsx";
import ThemeToggleButton from "./ThemeToggleButton.jsx";

// Zoom used when we actually know where the artist is from — close enough to
// read the city/region around the bubble.
export const ARTIST_ZOOM = 6;
// Zoom used for the Pacific "Unknown location" fallback. At ARTIST_ZOOM that
// spot is pure open water, which reads as a broken map rather than as "we
// don't know". Staying zoomed out keeps the Americas and Oceania in frame, so
// the empty ocean is legibly a deliberate nowhere.
export const UNKNOWN_ZOOM = 3;

export function zoomForLocation(location) {
  return location?.unknown ? UNKNOWN_ZOOM : ARTIST_ZOOM;
}

function MapController({ location }) {
  const map = useMap();
  useEffect(() => {
    if (location) {
      map.flyTo([location.lat, location.lng], zoomForLocation(location), {
        duration: 1.5,
      });
    }
  }, [location, map]);
  return null;
}

// MapContainer freezes its `className` prop at first mount (react-leaflet
// captures it once via useState and never re-applies it), so toggling
// darkMode via a className prop on MapContainer silently no-ops after the
// initial render. Setting the class imperatively through the map's own
// container element, the same way MapController drives flyTo, is what
// actually reacts to state changes.
function MapThemeClass({ darkMode }) {
  const map = useMap();
  useEffect(() => {
    map.getContainer().classList.toggle("dark-tiles", darkMode);
  }, [darkMode, map]);
  return null;
}

export default function LeafletMap({
  track,
  location,
  exploreMode,
  libraryArtists,
  onSelectArtist,
}) {
  // Dark by default, per design; resets on every mount — no persistence.
  const [darkMode, setDarkMode] = useState(true);

  return (
    <>
      <ThemeToggleButton
        darkMode={darkMode}
        onToggle={() => setDarkMode((v) => !v)}
      />
      <MapContainer
        center={[20, 0]}
        zoom={2}
        style={{ height: "100vh", width: "100%" }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        />
        <MapThemeClass darkMode={darkMode} />
        {!exploreMode && location && track && (
          <>
            <MapController location={location} />
            <AlbumBubble
              location={location}
              imageUrl={track.albumImageUrl}
              trackName={track.trackName}
              artistName={track.artistName}
            />
          </>
        )}
        {exploreMode && (
          <ArtistClusterLayer
            artists={libraryArtists}
            onSelectArtist={onSelectArtist}
          />
        )}
      </MapContainer>
    </>
  );
}
