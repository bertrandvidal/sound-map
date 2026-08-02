import L from "leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { ACCENT, SURFACE } from "../theme.js";
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

export default function ArtistClusterLayer({ artists, onSelectArtist }) {
  const resolved = (artists ?? []).filter((a) => a.status === "resolved");
  return (
    <MarkerClusterGroup iconCreateFunction={createClusterIcon}>
      {resolved.map((artist) => (
        <ArtistMarker
          key={artist.id}
          artist={artist}
          onSelect={onSelectArtist}
        />
      ))}
    </MarkerClusterGroup>
  );
}
