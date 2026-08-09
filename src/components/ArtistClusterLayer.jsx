import L from "leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { ACCENT, SURFACE } from "../theme.js";
import { UNKNOWN_LOCATION } from "../unknownLocation.js";
import ArtistMarker from "./ArtistMarker.jsx";
import "react-leaflet-cluster/dist/assets/MarkerCluster.css";
import "react-leaflet-cluster/dist/assets/MarkerCluster.Default.css";

// Themed replacement for the plugin's default blue/yellow cluster bubbles —
// same divIcon shape as leaflet.markercluster's own
// _defaultIconCreateFunction (a circle showing the child count), but built
// from the app's ACCENT/SURFACE palette so it matches AlbumBubble instead of
// looking like an unstyled plugin default.
function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const div = document.createElement("div");
  div.textContent = String(count);
  div.style.cssText = `width:40px;height:40px;border-radius:50%;background:${ACCENT};color:${SURFACE};border:3px solid ${SURFACE};box-shadow:0 2px 12px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-weight:bold;font-size:14px;`;
  return L.divIcon({ html: div, className: "", iconSize: [40, 40] });
}

// Which artists get a marker, and where. Exported and pure so the rule is
// testable without rendering react-leaflet — same pattern as
// LeafletMap.zoomForLocation.
//
// A not_found artist gets the same Pacific placeholder the now-playing bubble
// uses. Dropping them, as this layer used to, made an artist the user
// actually follows indistinguishable from one that was never fetched.
//
// pending and unavailable stay off the map deliberately: "unavailable" is an
// /api/geocode failure (Upstash outage, network hop, non-200), which means
// "no answer yet", not "no known origin". Placing it would let an outage
// render as a confident, complete answer — the same mistake
// useLibraryArtists' failedCount exists to prevent.
export function mappableArtists(artists) {
  return (artists ?? []).flatMap((artist) => {
    if (artist.status === "resolved") return [artist];
    if (artist.status === "not_found")
      return [{ ...artist, ...UNKNOWN_LOCATION }];
    return [];
  });
}

export default function ArtistClusterLayer({ artists, onSelectArtist }) {
  const mappable = mappableArtists(artists);
  return (
    <MarkerClusterGroup iconCreateFunction={createClusterIcon}>
      {mappable.map((artist) => (
        <ArtistMarker
          key={artist.id}
          artist={artist}
          onSelect={onSelectArtist}
        />
      ))}
    </MarkerClusterGroup>
  );
}
