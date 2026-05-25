import { useMemo } from 'react'
import { Marker, Popup } from 'react-leaflet'
import L from 'leaflet'

export default function AlbumBubble({ location, imageUrl, trackName, artistName }) {
  const icon = useMemo(() => L.divIcon({
    html: `<img
      src="${imageUrl}"
      alt="${artistName}"
      style="width:64px;height:64px;border-radius:50%;border:3px solid white;box-shadow:0 2px 12px rgba(0,0,0,0.5);display:block;"
    />`,
    className: '',
    iconSize: [64, 64],
    iconAnchor: [32, 32],
    popupAnchor: [0, -36],
  }), [imageUrl, artistName])

  return (
    <Marker position={[location.lat, location.lng]} icon={icon}>
      <Popup>
        <strong>{artistName}</strong><br />
        {trackName}<br />
        <em>{location.placeName}</em>
      </Popup>
    </Marker>
  )
}
