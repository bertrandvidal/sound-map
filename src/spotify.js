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

async function playerCommand(method, command, token, body, deviceId) {
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  const response = await fetch(
    `https://api.spotify.com/v1/me/player/${command}${query}`,
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

/**
 * Spotify Connect devices the account can currently reach.
 *
 * Needs the `user-read-playback-state` scope (see OAUTH_SCOPE in
 * server/auth.js). A session minted before that scope was added keeps working
 * for everything else, so a 403 here means "stale consent", NOT "no Premium"
 * — hence its own error rather than playerCommand's PLAYBACK_UNAVAILABLE.
 */
export async function fetchDevices(token) {
  const response = await fetch("https://api.spotify.com/v1/me/player/devices", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const err = spotifyError(response, {
    403: () => new Error("INSUFFICIENT_SCOPE"),
  });
  if (err) throw err;
  const data = await response.json();
  return data.devices ?? [];
}

// `is_restricted` devices accept no Web API commands at all, so targeting one
// would swap a 404 for a silent no-op. An already-active device is preferred
// when present; otherwise any open client will do — that's the whole point,
// since Spotify only refuses the bare call because *none* is active.
function pickPlaybackDevice(devices) {
  const usable = devices.filter((d) => !d.is_restricted && d.id);
  return usable.find((d) => d.is_active) ?? usable[0] ?? null;
}

/**
 * Start playback, recovering from Spotify's "no active device" refusal.
 *
 * `PUT /me/player/play` 404s when nothing is currently playing — the common
 * case on a fresh login, where the user has Spotify open somewhere but hasn't
 * pressed play. Rather than surfacing that as an error, look for a reachable
 * device and aim at it explicitly.
 *
 * Only `play` gets this treatment: pause/next against no device are genuinely
 * meaningless, and waking a client to immediately pause it would be surprising.
 */
export async function play(token, { contextUri, deviceId } = {}) {
  const body = contextUri ? { context_uri: contextUri } : undefined;
  try {
    return await playerCommand("PUT", "play", token, body, deviceId);
  } catch (err) {
    // An explicit deviceId that 404s is a dead device, not a missing one —
    // re-resolving would just pick the same list and loop.
    if (err.message !== "NO_ACTIVE_DEVICE" || deviceId) throw err;

    const device = pickPlaybackDevice(await fetchDevices(token));
    // Nothing open anywhere. No API call can fix this; the user has to open
    // Spotify, so let NO_ACTIVE_DEVICE through with its original meaning.
    if (!device) throw err;
    return playerCommand("PUT", "play", token, body, device.id);
  }
}
export const pause = (token) => playerCommand("PUT", "pause", token);
export const skipToNext = (token) => playerCommand("POST", "next", token);

/**
 * Peeks at the track Spotify will play next, so a caller can show it
 * optimistically the moment they trigger a skip instead of waiting on the
 * next-currently-playing poll (which lags behind a skip by up to POLL_MS,
 * and is briefly eventually-consistent right after one). Returns null if
 * there's nothing queued up — callers should fall back to their normal
 * resync path in that case.
 */
export async function fetchQueue(token) {
  const response = await fetch("https://api.spotify.com/v1/me/player/queue", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const err = spotifyError(response);
  if (err) throw err;

  const data = await response.json();
  const next = data.queue?.[0];
  if (!next) return null;

  return {
    trackName: next.name,
    artistName: next.artists[0]?.name ?? null,
    artistNames: next.artists.map((a) => a.name).join(", ") || null,
    albumImageUrl: next.album.images[0]?.url ?? null,
    trackId: next.id,
    isPlaying: true,
    progressMs: 0,
    durationMs: next.duration_ms,
  };
}

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
