import L from "leaflet";
import { useMemo } from "react";
import { Marker } from "react-leaflet";

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
    });
  }, [artist.imageUrl, artist.name]);

  return (
    <Marker
      position={[artist.lat, artist.lng]}
      icon={icon}
      eventHandlers={{ click: () => onSelect?.(artist) }}
    />
  );
}
