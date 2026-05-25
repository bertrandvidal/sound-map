const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID
const REDIRECT_URI = 'http://127.0.0.1:3000/callback'
const SCOPE = 'user-read-currently-playing'

export function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  })
  return `https://accounts.spotify.com/authorize?${params}`
}

export async function fetchCurrentlyPlaying(token) {
  const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (response.status === 204) return null
  if (response.status === 401) throw new Error('TOKEN_EXPIRED')
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') ?? '5'
    throw new Error(`RATE_LIMITED:${retryAfter}`)
  }
  if (!response.ok) throw new Error(`SPOTIFY_ERROR:${response.status}`)

  const data = await response.json()
  if (!data.item) return null

  return {
    trackName: data.item.name,
    artistName: data.item.artists[0].name,
    albumImageUrl: data.item.album.images[0].url,
  }
}
