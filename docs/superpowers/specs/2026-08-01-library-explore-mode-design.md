# Library Explore Mode — Design

**Date:** 2026-08-01
**Branch:** `library-explore-mode`
**Status:** approved (brainstorming), pending spec review

## Problem

The map currently shows exactly one artist at a time — whoever is playing right
now (`MapView.jsx` → `LeafletMap.jsx` → `AlbumBubble.jsx`, driven by `flyTo`).
There's no way to see where the rest of your library "lives" on the map.

## Goal

A toggleable **explore mode**: a button switches the map from "now playing"
(current behavior, unchanged) to a clustered view of every artist the user
follows, geocoded to a marker. Clicking a resolved artist starts playing them.
Resolution of the (potentially large) artist list happens progressively in the
background, starting at app load, with a visible progress indicator.

## Non-goals

- Changing the "now playing" single-marker flow — it is untouched, and its
  code path (`src/geo.js`, `AlbumBubble.jsx`) is not reused by explore mode
  (see "Why a separate geocoding path" below).
- "Library" scope beyond followed artists. Saved tracks/saved albums are a
  possible future expansion (larger, dedup required) but out of scope here —
  `GET /me/following?type=artist` is the source of truth for v1.
- Any change to playback UI beyond "click marker → play this artist."
- Building our own geocoding service or self-hosting Nominatim/MusicBrainz.

## Data flow

```
App boot (token available)
  → fetchFollowedArtists(token)             [src/spotify.js, client → Spotify, paginated]
  → for each artist, sequentially:
       POST /api/geocode { artistId, artistName }   [client → our backend]
         → cache hit (Redis)?  return immediately
         → cache miss: acquire global throttle lock (Redis) → MusicBrainz → Nominatim
           → cache result (incl. "not_found") → return
         → throttle lock held by someone else → { status: "throttled", retryAfterMs }
  → progress: resolvedCount/total drives the bottom-left loading bubble
  → resolved artists accumulate in React state, feeding the explore-mode map layer

User clicks "Browse library"
  → map swaps its marker layer: now-playing AlbumBubble → clustered library markers
    (whatever has resolved so far; more pop in as background resolution continues)
  → NowPlayingCard (top-right) is unaffected by mode — it only reflects `track`

User clicks a library marker
  → play(token, { contextUri: `spotify:artist:${artist.id}` })
```

## Why a separate geocoding path from `src/geo.js`

`src/geo.js#lookupArtistLocation` runs **in the browser**, calling MusicBrainz
and Nominatim directly, with no cache and no rate limiting. That's fine for
one lookup every few seconds (current-track polling) but cannot be reused for
bulk resolution:

- Nominatim's usage policy caps anonymous use at 1 req/sec and *requires*
  caching — bulk, uncached geocoding from hundreds of browser sessions would
  violate it immediately.
- MusicBrainz's anonymous limit is the same, 1 req/sec.
- Browser-side rate limiting can't be enforced globally anyway — every tab is
  an independent JS runtime with no shared state.

So explore mode gets its own **server-side, cached, globally-throttled**
lookup (`server/geocode.js` + `server/kv.js` + `api/geocode.js`). This
duplicates the ~15-line MusicBrainz→Nominatim fetch logic that already exists
in `src/geo.js`. That's a deliberate, small duplication rather than forcing a
shared module across the browser/serverless boundary for two call sites with
different operational requirements (one uncached, one cached+throttled) —
simpler than an abstraction neither side fully needs.

## New Spotify scope

Add `user-follow-read` to `OAUTH_SCOPE` in `server/auth.js:5`:

```js
const OAUTH_SCOPE =
  "user-read-currently-playing user-modify-playback-state user-follow-read";
```

**Migration note:** a scope change only takes effect on the *next* login —
existing sessions' refresh tokens keep the scope grant from when the user
originally authorized the app. `fetchFollowedArtists` will get a `403` for any
session created before this ships. The client must treat that as an expected,
handled case (message: "Log out and back in to enable Browse Library"), not a
crash.

## Reading followed artists — client-side, no new backend endpoint

Like `fetchCurrentlyPlaying`/`play`/`pause`/`skipToNext`, this is a direct
browser → Spotify call (the existing architecture never proxies Spotify reads
through our backend — only OAuth token exchange goes through `api/*.js`). Add
to `src/spotify.js`:

```js
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
      artists.push({ id: a.id, name: a.name, imageUrl: a.images[0]?.url ?? null });
    }
    after = data.artists.cursors.after ?? null;
  } while (after);
  return artists;
}
```

`spotifyError` already throws `TOKEN_EXPIRED` (401) and `SPOTIFY_ERROR:<status>`
(anything else not overridden) — a `403` (missing scope) falls through to
`SPOTIFY_ERROR:403` with no new branch needed. The consuming hook (below)
special-cases that string.

## Geocode cache + rate limiter — Redis (Upstash, via Vercel Marketplace)

"Redis on Vercel" *is* Upstash Redis today — Vercel retired the first-party
"Vercel KV" product in Dec 2024 and the Marketplace listing now provisions an
Upstash-backed database; there is no separate first-party alternative to
evaluate. Install it from the Vercel Marketplace ("Upstash for Redis"); it
injects `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`
/ `UPSTASH_REDIS_REST_TOKEN` depending on how the integration is connected —
confirm the exact names once provisioned and use whichever `Redis.fromEnv()`
picks up; see Task 0 in the plan). Free tier: ~500K commands/month, ~256MB
storage — orders of magnitude more than this feature needs (a few hundred to
low thousands of cached artists, each a small JSON blob).

### Keys

| Key | Value | TTL |
|---|---|---|
| `geo:{spotifyArtistId}` | `{ status: "resolved", lat, lng, placeName, resolvedAt }` | none (locations don't change) |
| `geo:{spotifyArtistId}` | `{ status: "not_found", resolvedAt }` | 30 days (retry later — MusicBrainz data improves over time) |
| `throttle:musicbrainz` | `"1"` | `GEOCODE_MIN_INTERVAL_MS` |
| `throttle:nominatim` | `"1"` | `GEOCODE_MIN_INTERVAL_MS` |

Keyed by **Spotify artist ID**, not name — two different Spotify artists can
share a display name, and the ID is already on hand from the followed-artists
response, so this avoids a name-collision class of bug for free.

### Throttle algorithm

Vercel functions are stateless and can run concurrently, so an in-memory
"last call was N ms ago" check does nothing — two concurrent invocations would
both pass it. The lock has to be a single atomic Redis operation:

```js
// Returns true if the caller may proceed (and has "claimed" the slot),
// false if another caller currently holds it.
async function tryAcquireThrottle(redis, service, minIntervalMs) {
  const result = await redis.set(`throttle:${service}`, "1", {
    nx: true,
    px: minIntervalMs,
  });
  return result !== null; // null = key already existed = still throttled
}
```

`SET key value NX PX <ms>` is a single round trip: it sets the key only if
absent, with the key expiring after `minIntervalMs` — so the *next* caller
after the window can acquire it, with no separate "read last timestamp, compare,
write" race.

`GEOCODE_MIN_INTERVAL_MS` is an env var (default `1100`, safely above both
services' 1 req/sec floor) — read at request time in `api/geocode.js`, no code
change needed to retune it.

### `POST /api/geocode`

Gate access with the existing session cookie (same pattern as `api/refresh.js`
— check `COOKIE_NAME` is present; this endpoint touches no Spotify user data,
so it doesn't need to *decrypt* the cookie, just confirm the caller is a
logged-in user of this app rather than the open internet, since abuse would
burn our shared MusicBrainz/Nominatim rate budget):

Request: `{ artistId: string, artistName: string }`

Responses (all `200` except errors — this is a queue-status endpoint, not a
per-artist error):
- `{ status: "resolved", lat, lng, placeName }` — cache hit or fresh lookup succeeded
- `{ status: "not_found" }` — cache hit or fresh lookup found no area data
- `{ status: "throttled", retryAfterMs: <GEOCODE_MIN_INTERVAL_MS> }` — try again shortly
- `401 { error: "no_session" }`, `400 { error: "invalid_request" }`

Flow: check `geo:{artistId}` cache first (no throttle interaction on a hit).
On miss: `tryAcquireThrottle(redis, "musicbrainz", ...)` — if denied, return
`throttled`. If granted, call MusicBrainz; if it returns an area name, THEN
`tryAcquireThrottle(redis, "nominatim", ...)` for the second call (if that one
is denied, return `throttled` — the MusicBrainz result isn't cached yet, so
the next request just redoes both steps; acceptable, keeps the endpoint
stateless between calls). On success or "no area data," write the cache entry
before responding.

### Why no in-function sleeping

A denied throttle returns immediately rather than waiting out the window
inside the function — sleeping risks the Vercel execution timeout and bills
for idle wait. The client's polling loop (below) is what actually paces the
requests.

## Client-side resolution loop

New hook, `src/useLibraryArtists.js`:

- On mount (once `token` is available): call `fetchFollowedArtists(token)`
  once, store the full list with `status: "pending"` on each entry.
- Drive a **sequential** (concurrency 1) loop over pending artists: `POST
  /api/geocode`; on `resolved`/`not_found`, mark that artist done and move to
  the next immediately; on `throttled`, wait `retryAfterMs` then retry the
  *same* artist.
- Expose `{ artists, resolvedCount, total, scopeMissing }` — `scopeMissing`
  true if `fetchFollowedArtists` threw `SPOTIFY_ERROR:403` (stale session,
  see migration note above); the hook stops there rather than looping forever
  on a call that will never succeed.
- This loop runs regardless of explore mode — it starts at app load and keeps
  going in the background so that by the time the user opens explore mode,
  most/all of the library is already resolved. Because the throttle is global
  (Redis-backed, shared across every user's Vercel function invocations), the
  actual external call rate is bounded app-wide, not per-session.

## UI

**Two new bottom-left overlays**, using the existing `overlayCardStyle` /
`LogoutButton`-style patterns (`src/theme.js`), leaving the bottom-right
`LogoutButton` and top-right `NowPlayingCard` untouched:

1. **`LibraryLoadingBadge`** — small pill, `position: fixed; bottom: 72; left: 16`,
   text "Loading library 12/359", visible whenever `resolvedCount < total`,
   with a CSS blink/pulse animation on the text (matches the "blinking text"
   ask). Disappears once `resolvedCount === total`. Rendered regardless of
   explore mode — it reflects background progress, not the current view.

2. **`BrowseLibraryButton`** — `position: fixed; bottom: 16; left: 16`, same
   visual identity as `LogoutButton`. Label toggles: "Browse library" ↔ "Now
   playing", flipping `exploreMode` boolean state (owned by `MapView`).

**`LeafletMap.jsx`** gains an `exploreMode` + `libraryArtists` prop pair:
- `exploreMode === false` (default): current behavior, byte-for-byte — the
  `AlbumBubble`/`MapController`/`flyTo` block, untouched.
- `exploreMode === true`: renders a new `ArtistClusterLayer` instead, built on
  `react-leaflet-cluster` (supports React 19 + react-leaflet v5 as of the
  current release — confirmed compatible peer deps). Only artists with
  `status: "resolved"` get a marker (`not_found` artists are silently
  excluded — no coordinates to place them at).

**`ArtistMarker.jsx`** (new, sibling to `AlbumBubble.jsx`, same `L.divIcon`
technique): circular artist-image bubble, same 64px/white-border/shadow style
as `AlbumBubble`, so a marker "breaking out" of a cluster on zoom-in looks
visually consistent with the now-playing bubble. `react-leaflet-cluster`
handles the zoomed-out cluster-count bubbles automatically; style its
`iconCreateFunction` to use the app's `ACCENT`/`SURFACE` palette instead of
the plugin's default green, so it doesn't look like an unstyled third-party
widget.

**Click → play**: `ArtistMarker`'s `onClick` calls
`play(token, { contextUri: `spotify:artist:${artist.id}` })` (see below for
the `play()` signature change), routed through `MapView`'s existing
`runControl`/`refreshToken` error handling so a `TOKEN_EXPIRED` mid-explore
behaves the same as it does for the transport controls today.

There is no separate "which track" decision on our side: a `context_uri` of
`spotify:artist:{id}` is exactly what Spotify's own clients send when you hit
"Play" on an artist's profile page — Spotify's server picks the track
sequence (a shuffle-style run through that artist's popular tracks), not us.

**The app stays in explore mode after the click** — it does not auto-switch
back to "now playing" mode. `NowPlayingCard` (top-right) is always rendered
regardless of `exploreMode` and reflects the new track within one poll cycle,
so there's no need to leave the map view to see what started playing.
Explore mode is meant to be browsed — clicking one artist and then another in
sequence is the expected flow, not a one-shot picker that dumps you back into
single-marker mode. (The now-playing `flyTo`/`AlbumBubble` marker stays
suppressed throughout, per the `!exploreMode` gate in `LeafletMap` — clicking
around in explore mode never fights with it.)

## `play()` gains an optional body

Spotify's `PUT /me/player/play` accepts `context_uri` (album/artist/playlist)
in the request body to start playback of that context. Current
`playerCommand` in `src/spotify.js` never sends a body:

```js
async function playerCommand(method, command, token, body) {
  const response = await fetch(`https://api.spotify.com/v1/me/player/${command}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  ...unchanged error handling...
}

export const play = (token, body) => playerCommand("PUT", "play", token, body);
```

`play(token)` (no body) keeps its current "resume playback" meaning — the
existing play/pause button in `NowPlayingCard` is unaffected.

## Trade-offs

- **Followed artists only, not saved tracks/albums.** Narrower than "full
  library" but avoids paginating potentially thousands of saved tracks and
  deduping artists across them for v1. Revisit if the author wants deeper
  coverage later.
- **Background prefetch runs even if the user never opens explore mode.**
  Slight always-on cost (one Spotify call + a trickle of geocode calls per
  session) in exchange for explore mode feeling instant/mostly-populated the
  first time it's opened. Bounded by the global throttle either way.
- **`not_found` artists are invisible on the map**, not shown with a fallback
  pin (unlike the "now playing" Pacific-Ocean fallback). Explore mode is a
  browsing view of many artists, not a single-track focus — a pile of markers
  at `{0, -160}` for every unresolvable artist would be misleading clutter,
  not a fallback worth keeping consistent with the single-track case.

## Verification

1. `npm test` green, including new suites for `server/geocode.js`,
   `server/kv.js` (mocked `@upstash/redis` client — no real credentials
   needed in CI), `api/geocode.js`, `fetchFollowedArtists`, `play(token, body)`,
   and `useLibraryArtists`. Per-file coverage bar (statements 90 / branches 75
   / functions 100) applies to every new file except ones added to the
   existing DOM/canvas exclude list in `vite.config.js` (new Leaflet-rendering
   components follow `AlbumBubble.jsx`/`LeafletMap.jsx`'s precedent).
2. `npx biome check .` clean.
3. Manual, against a real Upstash database and a re-authenticated (post-scope)
   Spotify session: log in, confirm the bottom-left "Loading library X/Y"
   badge appears and counts up, click "Browse library" and see clustered
   markers appear/populate, zoom in on a cluster and confirm individual artist
   bubbles render, click one and confirm playback starts on that artist,
   toggle back to "Now playing" and confirm the original single-marker
   behavior is unchanged.
