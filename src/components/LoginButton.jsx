import { buildAuthUrl } from '../spotify.js'

export default function LoginButton({ error }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      fontFamily: 'sans-serif',
      gap: '12px',
    }}>
      <h1>sound-map</h1>
      {error === 'access_denied' && <p style={{ color: 'red' }}>Access denied. Please try again.</p>}
      {error === 'token_exchange_failed' && <p style={{ color: 'red' }}>Login failed. Please try again.</p>}
      {error === 'session_expired' && <p style={{ color: 'orange' }}>Session expired (1 hour limit). Please log in again.</p>}
      <a href={buildAuthUrl()} style={{ textDecoration: 'none' }}>
        <button style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer' }}>
          Login with Spotify
        </button>
      </a>
    </div>
  )
}
