const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
if (!CLIENT_ID)
  throw new Error("VITE_SPOTIFY_CLIENT_ID is not set — check your .env file");
const SCOPE = "user-read-currently-playing user-modify-playback-state";

const RATE_LIMITED_DEFAULT = "5";

// Non-success Spotify response -> the Error we throw. Returns null for 2xx.
// `overrides` adds endpoint-specific status codes (e.g. player controls' 403/404).
function spotifyError(response, overrides = {}) {
  const byStatus = {
    401: () => new Error("TOKEN_EXPIRED"),
    429: () =>
      new Error(
        `RATE_LIMITED:${response.headers.get("Retry-After") ?? RATE_LIMITED_DEFAULT}`,
      ),
    ...overrides,
  };
  if (byStatus[response.status]) return byStatus[response.status]();
  return response.ok ? null : new Error(`SPOTIFY_ERROR:${response.status}`);
}

export function buildAuthUrl() {
  const redirectUri =
    import.meta.env.VITE_REDIRECT_URI ?? "http://127.0.0.1:3000/api/callback";
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export async function fetchCurrentlyPlaying(token) {
  const response = await fetch(
    "https://api.spotify.com/v1/me/player/currently-playing",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  if (response.status === 204) return null;
  const err = spotifyError(response);
  if (err) throw err;

  const data = await response.json();
  if (!data.item) return null;

  return {
    trackName: data.item.name,
    artistName: data.item.artists[0]?.name ?? null, // PRIMARY artist — keep, used elsewhere for geo lookup
    artistNames: data.item.artists.map((a) => a.name).join(", ") || null, // all artists joined, for display
    albumImageUrl: data.item.album.images[0]?.url ?? null,
    trackId: data.item.id,
    isPlaying: data.is_playing,
    progressMs: data.progress_ms,
    durationMs: data.item.duration_ms,
  };
}

async function playerCommand(method, command, token) {
  const response = await fetch(
    `https://api.spotify.com/v1/me/player/${command}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (response.status === 204) return; // success (no body)
  const err = spotifyError(response, {
    403: () => new Error("PLAYBACK_UNAVAILABLE"), // non-Premium / restricted
    404: () => new Error("NO_ACTIVE_DEVICE"),
  });
  if (err) throw err;
}

export const play = (token) => playerCommand("PUT", "play", token);
export const pause = (token) => playerCommand("PUT", "pause", token);
export const skipToNext = (token) => playerCommand("POST", "next", token);
