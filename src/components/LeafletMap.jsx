import { useEffect } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import AlbumBubble from './AlbumBubble.jsx'

function MapController({ location }) {
  const map = useMap()
  useEffect(() => {
    if (location) {
      map.flyTo([location.lat, location.lng], 8, { duration: 1.5 })
    }
  }, [location, map])
  return null
}

export default function LeafletMap({ track, location }) {
  return (
    <MapContainer
      center={[20, 0]}
      zoom={2}
      style={{ height: '100vh', width: '100%' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      {location && track && (
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
    </MapContainer>
  )
}
