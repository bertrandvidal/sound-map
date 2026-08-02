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

async function playerCommand(method, command, token, body) {
  const response = await fetch(
    `https://api.spotify.com/v1/me/player/${command}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (response.status === 204) return; // success (no body)
  const err = spotifyError(response, {
    403: () => new Error("PLAYBACK_UNAVAILABLE"), // non-Premium / restricted
    404: () => new Error("NO_ACTIVE_DEVICE"),
  });
  if (err) throw err;
}

export const play = (token, { contextUri } = {}) =>
  playerCommand(
    "PUT",
    "play",
    token,
    contextUri ? { context_uri: contextUri } : undefined,
  );
export const pause = (token) => playerCommand("PUT", "pause", token);
export const skipToNext = (token) => playerCommand("POST", "next", token);

export async function fetchFollowedArtists(token) {
  const artists = [];
  let after;
  do {
    const url = new URL("https://api.spotify.com/v1/me/following");
    url.searchParams.set("type", "artist");
    url.searchParams.set("limit", "50");
    if (after) url.searchParams.set("after", after);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const err = spotifyError(response);
    if (err) throw err;
    const data = await response.json();
    for (const a of data.artists.items) {
      artists.push({
        id: a.id,
        name: a.name,
        imageUrl: a.images[0]?.url ?? null,
      });
    }
    after = data.artists.cursors.after ?? null;
  } while (after);
  return artists;
}
