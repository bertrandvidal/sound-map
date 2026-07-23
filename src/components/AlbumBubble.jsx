import L from "leaflet";
import { useMemo } from "react";
import { Marker, Popup } from "react-leaflet";
import "./albumPopup.css";
import AlbumPopupCard from "./AlbumPopupCard.jsx";

export default function AlbumBubble({
  location,
  imageUrl,
  trackName,
  artistName,
}) {
  const icon = useMemo(() => {
    const img = document.createElement("img");
    img.src = imageUrl ?? "";
    img.alt = artistName;
    img.style.cssText =
      "width:64px;height:64px;border-radius:50%;border:3px solid white;box-shadow:0 2px 12px rgba(0,0,0,0.5);display:block;";
    return L.divIcon({
      html: img,
      className: "",
      iconSize: [64, 64],
      iconAnchor: [32, 32],
      popupAnchor: [0, -36],
    });
  }, [imageUrl, artistName]);

  // Use == null (not truthiness) so a valid 0 coordinate — e.g. the Pacific
  // "Unknown location" fallback at lat 0 — still renders the bubble.
  if (location?.lat == null || location?.lng == null) return null;

  return (
    <Marker position={[location.lat, location.lng]} icon={icon}>
      <Popup>
        <AlbumPopupCard
          imageUrl={imageUrl}
          trackName={trackName}
          artistName={artistName}
          placeName={location.placeName}
        />
      </Popup>
    </Marker>
  );
}
