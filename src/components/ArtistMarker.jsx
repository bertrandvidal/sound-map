import L from "leaflet";
import { useMemo } from "react";
import { Marker, Tooltip } from "react-leaflet";
import "./artistTooltip.css";

// Same L.divIcon technique as AlbumBubble.jsx (64px circular image, white
// border, drop shadow) so a resolved library artist reads as the same kind
// of marker as the now-playing bubble, just without a popup — clicking it
// hands the artist off to onSelect instead.
export default function ArtistMarker({ artist, onSelect }) {
  const icon = useMemo(() => {
    const img = document.createElement("img");
    img.src = artist.imageUrl ?? "";
    img.alt = artist.name;
    img.style.cssText =
      "width:64px;height:64px;border-radius:50%;border:3px solid white;box-shadow:0 2px 12px rgba(0,0,0,0.5);display:block;";
    return L.divIcon({
      html: img,
      className: "",
      iconSize: [64, 64],
      iconAnchor: [32, 32],
      // Mirrors AlbumBubble.jsx's popupAnchor: [0, -36]. Leaflet's Tooltip
      // (like Popup) positions itself at iconAnchor + tooltipAnchor; with no
      // tooltipAnchor set it defaults to [0, 0] and the tooltip anchors at
      // the bubble's centre, overlapping it. -36 lifts it clear of the 64px
      // (32px-radius) circle by the same 4px margin the now-playing popup
      // uses, so both floating cards sit at the same height above their
      // bubble.
      tooltipAnchor: [0, -36],
    });
  }, [artist.imageUrl, artist.name]);

  return (
    <Marker
      position={[artist.lat, artist.lng]}
      icon={icon}
      eventHandlers={{ click: () => onSelect?.(artist) }}
    >
      {/* Leaflet's Tooltip binds to the marker's mouseover/mouseout by
          default (no extra event wiring needed) — this is the hover-to-see
          behavior itself, not just its styling. */}
      <Tooltip className="artist-tooltip" direction="top" opacity={1}>
        <div className="artist-tooltip-name">{artist.name}</div>
        {/* Same 📍-prefixed treatment as AlbumPopupCard.jsx's place line,
            and same graceful omission when there's no place to show — never
            render a lone pin or the literal string "undefined". */}
        {artist.placeName && (
          <div className="artist-tooltip-place">📍 {artist.placeName}</div>
        )}
      </Tooltip>
    </Marker>
  );
}
