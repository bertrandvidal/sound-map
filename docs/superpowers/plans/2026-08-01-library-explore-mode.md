# Library Explore Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable "explore mode" that shows every artist the user
follows as clustered map markers (instead of the single now-playing marker),
resolved progressively via a new cached, rate-limited, server-side geocoding
path. Clicking a resolved artist starts playing them.

**Architecture:** See companion spec for full rationale — this plan implements
it. Summary: client reads followed artists directly from Spotify (like all
other Spotify reads in this app); a new `api/geocode.js` endpoint, backed by
Upstash Redis (cache + a `SET NX PX` distributed throttle), resolves each
artist's location via MusicBrainz + Nominatim, globally rate-limited; the
client drives a sequential resolve loop starting at app boot and renders
results as clustered `react-leaflet-cluster` markers when explore mode is on.

**Tech Stack:** Vite + React 19 SPA, `react-leaflet` v5, Vercel serverless
functions, `@upstash/redis`, Vitest, Biome.

**Companion spec:** `docs/superpowers/specs/2026-08-01-library-explore-mode-design.md`

## Global Constraints

- Never commit to `main`. Work happens on branch `library-explore-mode`;
  finish with a PR to `main`.
- Commit messages follow `~/.git-template.txt`: **Why / How / Tests** sections.
- The pre-commit hook runs `npx biome check . && npm test` on every commit.
  Never bypass with `--no-verify`. If Biome flags a file, run
  `npx biome check --write <file>`, `git add`, re-commit.
- Coverage bar (`vite.config.js`) is per-file: statements 90, branches 75,
  functions 100, for every file under `src/**/*.{js,jsx}`, `server/**/*.js`,
  `api/**/*.js` **except** the existing disallow-list. New Leaflet-rendering
  components that need real canvas/DOM sizing jsdom lacks (following
  `AlbumBubble.jsx`/`LeafletMap.jsx`'s precedent) get added to that
  disallow-list in Task 8 — don't add a file there for any other reason.
- Design all new server-side modules (`server/kv.js`, `server/geocode.js`)
  for dependency injection (accept a client/fetch as a parameter or via a
  factory) so unit tests never need real Upstash/MusicBrainz/Nominatim
  credentials or network access — consistent with the existing `vi.stubGlobal
  ('fetch', ...)` pattern in `src/__tests__/geo.test.js`.

---

### Task 0: Provision Upstash Redis (operator step, manual)

**Files:** none (Vercel dashboard).

- [ ] **Step 1: Install the Redis integration**

In the Vercel dashboard → the project → Storage → Marketplace → install
"Upstash for Redis" (or `vercel integration add` from the CLI). Either connect
an existing Upstash account or let Vercel provision/manage one.

- [ ] **Step 2: Confirm the injected env var names**

After provisioning, check the project's Environment Variables settings for
exactly which names were injected — `KV_REST_API_URL` / `KV_REST_API_TOKEN`
or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. `Redis.fromEnv()`
(used in Task 3) supports both pairs, but record which pair is actually
present so `.env.example` (Task 11) documents the real names, not a guess.

- [ ] **Step 3: Pull env vars for local dev**

Run: `vercel env pull .env` (or manually copy the values) so `vercel dev`
picks them up locally. Do not commit `.env` (already gitignored).

Note: Tasks 1–10 do not require this to be done first — all new
server-side tests mock the Redis client. This task only blocks the manual
end-to-end verification in Task 12.

---

### Task 1: Add the `user-follow-read` scope

**Files:**
- Modify: `server/auth.js:5`
- Test: `server/__tests__/auth.test.js` (find and update the assertion on `OAUTH_SCOPE` / the authorize-URL builder's `scope` param)

**Interfaces:** none new — widens an existing constant.

- [ ] **Step 1: Update the scope constant**

```js
const OAUTH_SCOPE =
  "user-read-currently-playing user-modify-playback-state user-follow-read";
```

- [ ] **Step 2: Update the corresponding test assertion**

Find the existing test asserting the authorize URL's `scope` query param and
add `user-follow-read` to the expected string.

- [ ] **Step 3: Run tests, commit**

Run: `npm test` — expect PASS.
```bash
git add server/auth.js server/__tests__/auth.test.js
git commit   # Why/How/Tests: adds user-follow-read scope needed to read followed artists for explore mode
```

---

### Task 2: `fetchFollowedArtists` in `src/spotify.js`

**Files:**
- Modify: `src/spotify.js`
- Test: `src/__tests__/spotify.test.js`

**Interfaces:**
- Produces: `fetchFollowedArtists(token) -> Promise<{id, name, imageUrl}[]>`,
  throws `TOKEN_EXPIRED` / `RATE_LIMITED:<seconds>` / `SPOTIFY_ERROR:<status>`
  via the existing `spotifyError` helper (a `403` from a stale, pre-scope
  session naturally becomes `SPOTIFY_ERROR:403` — no new branch needed).

- [ ] **Step 1: Write failing tests**

Cover: single page (`cursors.after` null → one fetch), multi-page (`after`
cursor threaded into the second request's query string, results concatenated),
`imageUrl` falls back to `null` when `images` is empty, and each thrown-error
case (401 → `TOKEN_EXPIRED`, 429 → `RATE_LIMITED:<n>`, 403 → `SPOTIFY_ERROR:403`).
Mock `fetch` with `vi.stubGlobal`, same style as the existing
`fetchCurrentlyPlaying` tests in this file.

- [ ] **Step 2: Implement `fetchFollowedArtists`**

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
```

- [ ] **Step 3: Run tests, biome, commit**

```bash
npx vitest run src/__tests__/spotify.test.js
npx biome check --write src/spotify.js
git add src/spotify.js src/__tests__/spotify.test.js
git commit   # Why: explore mode needs the user's followed artists; How: cursor-paginated GET /me/following?type=artist; Tests: pagination, image fallback, error passthrough
```

---

### Task 3: `play()` accepts an optional context body

**Files:**
- Modify: `src/spotify.js`
- Test: `src/__tests__/spotify.test.js`

**Interfaces:**
- Changes: `play(token)` unchanged; `play(token, { contextUri })` now sends
  `{ "context_uri": contextUri }` as a JSON body.

- [ ] **Step 1: Write failing tests**

Assert: `play(token)` sends no body and no `Content-Type` header (current
behavior, must not regress); `play(token, { contextUri: "spotify:artist:X" })`
sends `Content-Type: application/json` and body
`{"context_uri":"spotify:artist:X"}`; `pause`/`skipToNext` unaffected (they
don't pass a body).

- [ ] **Step 2: Implement**

```js
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
  if (response.status === 204) return;
  const err = spotifyError(response, {
    403: () => new Error("PLAYBACK_UNAVAILABLE"),
    404: () => new Error("NO_ACTIVE_DEVICE"),
  });
  if (err) throw err;
}

export const play = (token, { contextUri } = {}) =>
  playerCommand("PUT", "play", token, contextUri ? { context_uri: contextUri } : undefined);
```

- [ ] **Step 3: Run tests, biome, commit**

```bash
npx vitest run src/__tests__/spotify.test.js
npx biome check --write src/spotify.js
git add src/spotify.js src/__tests__/spotify.test.js
git commit   # Why: explore mode needs to start playback of a specific artist; How: play() takes an optional context_uri body; Tests: with/without body, existing play/pause/skip unaffected
```

---

### Task 4: `server/geocode.js` — server-side MusicBrainz + Nominatim lookup

**Files:**
- Create: `server/geocode.js`
- Create: `server/__tests__/geocode.test.js`

**Interfaces:**
- Produces: `lookupArtistLocation(artistName) -> Promise<{lat, lng, placeName} | null>`
  — same contract as `src/geo.js`, deliberately duplicated server-side (see
  spec, "Why a separate geocoding path").

- [ ] **Step 1: Write failing tests**

Copy the structure of `src/__tests__/geo.test.js` (all 7 cases: no MB match,
no area, no Nominatim match, success via `begin-area`, success via `area`
fallback, MB HTTP error, Nominatim HTTP error) against the new module.

- [ ] **Step 2: Implement**

Port `src/geo.js` verbatim into `server/geocode.js` (same logic — MusicBrainz
`artist` search → `begin-area`/`area` name → Nominatim `search`). No browser
APIs are used in the original, so this is a straight copy with no adaptation.

- [ ] **Step 3: Run tests, biome, commit**

```bash
npx vitest run server/__tests__/geocode.test.js
npx biome check --write server/geocode.js
git add server/geocode.js server/__tests__/geocode.test.js
git commit   # Why: explore mode needs server-side geocoding it can cache+throttle; How: port the MusicBrainz+Nominatim lookup from src/geo.js; Tests: mirrors geo.test.js's 7 cases
```

---

### Task 5: `server/kv.js` — Redis cache + throttle helpers

**Files:**
- Create: `server/kv.js`
- Create: `server/__tests__/kv.test.js`
- Modify: `package.json` (add `@upstash/redis` dependency)

**Interfaces:**
- Produces:
  - `createRedisClient() -> Redis` (thin wrapper over `Redis.fromEnv()`, so
    tests can construct their own mock instead of calling this)
  - `getCachedArtist(redis, artistId) -> Promise<{status, lat?, lng?, placeName?} | null>`
  - `setCachedArtist(redis, artistId, value)` — `resolved` entries: no TTL;
    `not_found` entries: `{ ex: 60 * 60 * 24 * 30 }` (30 days)
  - `tryAcquireThrottle(redis, service, minIntervalMs) -> Promise<boolean>`

- [ ] **Step 1: Install the dependency**

```bash
npm install @upstash/redis
```

- [ ] **Step 2: Write failing tests**

Use a hand-rolled mock object (`{ get: vi.fn(), set: vi.fn() }`) as the
"redis" param — no real `@upstash/redis` client needed. Cover:
`getCachedArtist` returns `null` on cache miss, returns the parsed value on
hit; `setCachedArtist` calls `redis.set` with no `ex` option for `resolved`
and with `{ ex: 2592000 }` for `not_found`; `tryAcquireThrottle` returns
`true` when `redis.set(..., {nx:true, px:...})` resolves to a non-null value
and `false` when it resolves to `null`.

- [ ] **Step 3: Implement**

```js
import { Redis } from "@upstash/redis";

export const createRedisClient = () => Redis.fromEnv();

export async function getCachedArtist(redis, artistId) {
  const value = await redis.get(`geo:${artistId}`);
  return value ?? null;
}

export async function setCachedArtist(redis, artistId, value) {
  const options = value.status === "not_found" ? { ex: 60 * 60 * 24 * 30 } : undefined;
  await redis.set(`geo:${artistId}`, value, options);
}

export async function tryAcquireThrottle(redis, service, minIntervalMs) {
  const result = await redis.set(`throttle:${service}`, "1", {
    nx: true,
    px: minIntervalMs,
  });
  return result !== null;
}
```

Note: `@upstash/redis` auto-serializes non-string values with `JSON.stringify`
and parses them back on `get` — confirm this against the installed version's
docs during implementation; if it does NOT auto-parse, add explicit
`JSON.stringify`/`JSON.parse` in `setCachedArtist`/`getCachedArtist`.

- [ ] **Step 4: Run tests, biome, commit**

```bash
npx vitest run server/__tests__/kv.test.js
npx biome check --write server/kv.js
git add package.json package-lock.json server/kv.js server/__tests__/kv.test.js
git commit   # Why: explore mode needs a shared cache + distributed rate limiter; How: Redis(Upstash) wrapper, SET NX PX for the throttle lock; Tests: mocked redis client, no real credentials
```

---

### Task 6: `api/geocode.js` — the endpoint

**Files:**
- Create: `api/geocode.js`
- Create: `api/__tests__/geocode.test.js`

**Interfaces:**
- Produces: `POST /api/geocode`, body `{ artistId, artistName }` →
  `{ status: "resolved", lat, lng, placeName }` |
  `{ status: "not_found" }` |
  `{ status: "throttled", retryAfterMs }`,
  or `401 { error: "no_session" }` / `400 { error: "invalid_request" }` /
  `405` for non-POST (mirrors `api/refresh.js`'s method guard).
- Consumes: `parseCookies`, `COOKIE_NAME` from `server/auth.js` (presence
  check only, same as `api/refresh.js:8-11` — no need to decrypt); `server/kv.js`;
  `server/geocode.js`; `process.env.GEOCODE_MIN_INTERVAL_MS` (default `1100`
  if unset).

- [ ] **Step 1: Write failing tests**

Inject fake `redis`/`lookupArtistLocation` via a factory param (see Step 2)
so no real network/Redis is touched. Cover: missing cookie → `401`; missing
body fields → `400`; cache hit (`resolved` and `not_found`) → returned
without calling `lookupArtistLocation` or the throttle; cache miss +
throttle denied → `{status:"throttled", retryAfterMs}`; cache miss + throttle
granted + MusicBrainz finds no area → `not_found` cached and returned; cache
miss + throttle granted + Nominatim throttle denied on the second lock → also
`throttled`; full success path → `resolved` cached and returned; non-POST →
`405`.

- [ ] **Step 2: Implement**

Structure the handler so its dependencies (`redis`, `lookupArtistLocation`)
are injectable for tests but default to the real ones in production:

```js
import { COOKIE_NAME, parseCookies } from "../server/auth.js";
import { lookupArtistLocation } from "../server/geocode.js";
import {
  createRedisClient,
  getCachedArtist,
  setCachedArtist,
  tryAcquireThrottle,
} from "../server/kv.js";

export async function geocodeHandler(req, res, deps = {}) {
  const redis = deps.redis ?? createRedisClient();
  const lookup = deps.lookupArtistLocation ?? lookupArtistLocation;
  const minIntervalMs = Number(process.env.GEOCODE_MIN_INTERVAL_MS ?? 1100);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!parseCookies(req.headers.cookie)[COOKIE_NAME]) {
    return res.status(401).json({ error: "no_session" });
  }
  const { artistId, artistName } = req.body ?? {};
  if (!artistId || !artistName) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const cached = await getCachedArtist(redis, artistId);
  if (cached) return res.status(200).json(cached);

  if (!(await tryAcquireThrottle(redis, "musicbrainz", minIntervalMs))) {
    return res.status(200).json({ status: "throttled", retryAfterMs: minIntervalMs });
  }
  // lookup() does both the MusicBrainz and (if needed) Nominatim calls
  // internally; a Nominatim-side throttle is acquired inside it — see Step 3.
  const location = await lookup(artistName, {
    acquireNominatimThrottle: () => tryAcquireThrottle(redis, "nominatim", minIntervalMs),
  });
  if (location === "THROTTLED") {
    return res.status(200).json({ status: "throttled", retryAfterMs: minIntervalMs });
  }

  const value = location
    ? { status: "resolved", ...location, resolvedAt: Date.now() }
    : { status: "not_found", resolvedAt: Date.now() };
  await setCachedArtist(redis, artistId, value);
  return res.status(200).json(value);
}

export default function handler(req, res) {
  return geocodeHandler(req, res);
}
```

This requires `server/geocode.js#lookupArtistLocation` to accept an optional
second param `{ acquireNominatimThrottle }` and return the sentinel string
`"THROTTLED"` if that callback resolves `false` right before the Nominatim
call (instead of proceeding). Revisit Task 4's implementation to add this —
keep the default (no second arg) behaving exactly as today so the existing
`server/__tests__/geocode.test.js` cases from Task 4 don't need changes.

- [ ] **Step 3: Run tests, biome, commit**

```bash
npx vitest run api/__tests__/geocode.test.js server/__tests__/geocode.test.js
npx biome check --write api/geocode.js server/geocode.js
git add api/geocode.js api/__tests__/geocode.test.js server/geocode.js server/__tests__/geocode.test.js
git commit   # Why: explore mode needs a cached, globally-throttled geocode endpoint; How: session-gated POST, cache-then-throttle-then-lookup flow, SET NX PX lock shared across MusicBrainz+Nominatim; Tests: cache hit/miss, both throttle points, error/method guards
```

---

### Task 7: `src/useLibraryArtists.js` — the resolution-loop hook

**Files:**
- Create: `src/useLibraryArtists.js`
- Create: `src/__tests__/useLibraryArtists.test.js`

**Interfaces:**
- Produces: `useLibraryArtists(token) -> { artists, resolvedCount, total, scopeMissing }`
  where `artists` is `{id, name, imageUrl, status: "pending"|"resolved"|"not_found", lat?, lng?, placeName?}[]`.
- Consumes: `fetchFollowedArtists` (Task 2), `POST /api/geocode` via `fetch`.

- [ ] **Step 1: Write failing tests**

Use `@testing-library/react`'s `renderHook` (already a dependency via
`@testing-library/react`). Mock `fetchFollowedArtists` and `fetch` (for the
`/api/geocode` calls). Cover: happy path resolves all artists and
`resolvedCount` reaches `total`; a `throttled` response causes a retry of the
same artist after `retryAfterMs` (use fake timers); `not_found` still
advances `resolvedCount`; `fetchFollowedArtists` throwing `SPOTIFY_ERROR:403`
sets `scopeMissing: true` and stops (no geocode calls fired); unmount mid-loop
does not update state after unmount (mirror the `mountedRef` guard pattern in
`MapView.jsx`).

- [ ] **Step 2: Implement**

Sequential loop, one in-flight `/api/geocode` call at a time, driven by an
effect keyed on `token`. Track `mountedRef` like `MapView.jsx` does. On
`SPOTIFY_ERROR:403` from `fetchFollowedArtists`, set `scopeMissing` and return
early — do not start the geocode loop.

- [ ] **Step 3: Run tests, biome, commit**

```bash
npx vitest run src/__tests__/useLibraryArtists.test.js
npx biome check --write src/useLibraryArtists.js
git add src/useLibraryArtists.js src/__tests__/useLibraryArtists.test.js
git commit   # Why: drives background library resolution independent of explore mode being open; How: sequential /api/geocode loop with throttled-retry backoff; Tests: happy path, throttle retry, not_found, stale-scope stop, unmount safety
```

---

### Task 8: UI — `LibraryLoadingBadge` and `BrowseLibraryButton`

**Files:**
- Create: `src/components/LibraryLoadingBadge.jsx`
- Create: `src/components/BrowseLibraryButton.jsx`
- Create: `src/components/__tests__/LibraryLoadingBadge.test.jsx`
- Create: `src/components/__tests__/BrowseLibraryButton.test.jsx`

**Interfaces:**
- `LibraryLoadingBadge({ resolvedCount, total })` — renders `null` when
  `total === 0 || resolvedCount >= total`; otherwise a pill reading
  `Loading library {resolvedCount}/{total}` with a pulsing/blinking text
  animation.
- `BrowseLibraryButton({ exploreMode, onToggle })` — button labeled
  `exploreMode ? "Now playing" : "Browse library"`, calls `onToggle` on click.

- [ ] **Step 1: Write failing tests**

`LibraryLoadingBadge`: renders nothing at `0/0` and at `359/359`; renders the
counter text at `12/359`. `BrowseLibraryButton`: renders "Browse library" when
`exploreMode` is false, "Now playing" when true, calls `onToggle` on click.
Mirror `src/components/__tests__/LogoutButton.test.jsx`'s structure.

- [ ] **Step 2: Implement**

`BrowseLibraryButton` — copy `LogoutButton.jsx`'s structure (`overlayCardStyle`,
fixed position), positioned `bottom: 16, left: 16` (mirrored from
`LogoutButton`'s `bottom: 16, right: 16`).

`LibraryLoadingBadge` — same `overlayCardStyle` pill, positioned
`bottom: 72, left: 16` (stacked directly above the button — adjust the exact
offset during implementation if it visually collides with the button's actual
rendered height). Use a CSS `@keyframes` opacity pulse (inline `<style>` tag
or a small `.css` import, matching how `albumPopup.css` is done for
`AlbumBubble`) for the blink.

- [ ] **Step 3: Run tests, biome, commit**

```bash
npx vitest run src/components/__tests__/LibraryLoadingBadge.test.jsx src/components/__tests__/BrowseLibraryButton.test.jsx
npx biome check --write src/components/LibraryLoadingBadge.jsx src/components/BrowseLibraryButton.jsx
git add src/components/LibraryLoadingBadge.jsx src/components/BrowseLibraryButton.jsx src/components/__tests__/LibraryLoadingBadge.test.jsx src/components/__tests__/BrowseLibraryButton.test.jsx
git commit   # Why: surface background resolution progress and the explore-mode toggle; How: bottom-left badge (auto-hides when done) + toggle button styled like LogoutButton; Tests: visibility thresholds, label toggle, click handler
```

---

### Task 9: Explore-mode map layer — clustering + artist markers

**Files:**
- Modify: `package.json` (add `react-leaflet-cluster` dependency)
- Create: `src/components/ArtistMarker.jsx`
- Create: `src/components/ArtistClusterLayer.jsx`
- Modify: `src/components/LeafletMap.jsx`
- Modify: `vite.config.js` (add the two new files to the coverage `exclude` list)

**Interfaces:**
- `ArtistMarker({ artist, onSelect })` — `L.divIcon` circular image bubble
  (same 64px/white-border/shadow visual as `AlbumBubble`), calls
  `onSelect(artist)` on click. `artist` is one entry from `useLibraryArtists`
  with `status: "resolved"`.
- `ArtistClusterLayer({ artists, onSelectArtist })` — wraps
  `react-leaflet-cluster`'s `MarkerClusterGroup`, rendering one `ArtistMarker`
  per resolved artist; custom `iconCreateFunction` styled with `ACCENT`/`SURFACE`
  from `src/theme.js` instead of the plugin's default colors.
- `LeafletMap` gains props `exploreMode` (bool) and `libraryArtists` (array)
  and `onSelectArtist` (callback), alongside its existing `track`/`location`.

- [ ] **Step 1: Install the dependency**

```bash
npm install react-leaflet-cluster
```

Import its two CSS files (required manually, not auto-imported by the
package) wherever `ArtistClusterLayer.jsx` is defined:
```js
import "react-leaflet-cluster/dist/assets/MarkerCluster.css";
import "react-leaflet-cluster/dist/assets/MarkerCluster.Default.css";
```

- [ ] **Step 2: Add the new files to the coverage exclude list**

In `vite.config.js`, add to `test.coverage.exclude`, next to the existing
`AlbumBubble.jsx`/`LeafletMap.jsx` entries, with the same justification
comment style:

```js
"src/components/ArtistMarker.jsx", // builds a Leaflet divIcon; same canvas/DOM constraint as AlbumBubble
"src/components/ArtistClusterLayer.jsx", // wraps react-leaflet-cluster; needs real map sizing jsdom lacks
```

- [ ] **Step 3: Implement `ArtistMarker.jsx`**

Same `L.divIcon` technique as `AlbumBubble.jsx` (build an `<img>` element,
64px circle, white border, box-shadow), positioned at `[artist.lat, artist.lng]`,
`onClick` calling `onSelect(artist)`.

- [ ] **Step 4: Implement `ArtistClusterLayer.jsx`**

```jsx
import MarkerClusterGroup from "react-leaflet-cluster";
import { ACCENT, SURFACE } from "../theme.js";
import ArtistMarker from "./ArtistMarker.jsx";
import "react-leaflet-cluster/dist/assets/MarkerCluster.css";
import "react-leaflet-cluster/dist/assets/MarkerCluster.Default.css";

export default function ArtistClusterLayer({ artists, onSelectArtist }) {
  const resolved = artists.filter((a) => a.status === "resolved");
  return (
    <MarkerClusterGroup
      iconCreateFunction={(cluster) => {
        // themed cluster bubble using ACCENT/SURFACE — see spec's "UI" section
      }}
    >
      {resolved.map((artist) => (
        <ArtistMarker key={artist.id} artist={artist} onSelect={onSelectArtist} />
      ))}
    </MarkerClusterGroup>
  );
}
```

- [ ] **Step 5: Wire into `LeafletMap.jsx`**

```jsx
export default function LeafletMap({
  track,
  location,
  exploreMode,
  libraryArtists,
  onSelectArtist,
}) {
  return (
    <MapContainer center={[20, 0]} zoom={2} style={{ height: "100vh", width: "100%" }}>
      <TileLayer ... />
      {!exploreMode && location && track && (
        <>
          <MapController location={location} />
          <AlbumBubble ... />
        </>
      )}
      {exploreMode && (
        <ArtistClusterLayer artists={libraryArtists} onSelectArtist={onSelectArtist} />
      )}
    </MapContainer>
  );
}
```

The existing now-playing block is otherwise untouched — only gated behind
`!exploreMode`.

- [ ] **Step 6: Manual smoke check (this file's logic isn't unit-testable per the exclude list)**

Run `npm run dev` or `npm start`, confirm the app still builds/renders with no
console errors after adding the new imports (full interactive verification
happens in Task 12 once the rest of the wiring exists).

- [ ] **Step 7: Run full suite, biome, commit**

```bash
npm test
npx biome check --write package.json src/components/ArtistMarker.jsx src/components/ArtistClusterLayer.jsx src/components/LeafletMap.jsx vite.config.js
git add package.json package-lock.json src/components/ArtistMarker.jsx src/components/ArtistClusterLayer.jsx src/components/LeafletMap.jsx vite.config.js
git commit   # Why: explore mode's map layer; How: react-leaflet-cluster + themed cluster icons + per-artist divIcon markers, gated behind exploreMode; Tests: N/A for these files (DOM/canvas exclude, same as AlbumBubble/LeafletMap) — rest of the suite green
```

---

### Task 10: Wire it all together in `MapView.jsx`

**Files:**
- Modify: `src/components/MapView.jsx`
- Modify: `src/components/__tests__/MapView.test.jsx`

**Interfaces:**
- `MapView` gains local state `exploreMode` (bool, default `false`) and calls
  `useLibraryArtists(token)` unconditionally (background loop runs regardless
  of mode, per spec).
- Passes `exploreMode`, `libraryArtists`, `onSelectArtist` down to `LeafletMap`.
- Renders `LibraryLoadingBadge` and `BrowseLibraryButton` alongside the
  existing `NowPlayingCard` (which stays conditioned only on `track`, not on
  `exploreMode` — per spec, it reflects playback state regardless of view).
- `onSelectArtist(artist)` calls `runControl(() => play(token, { contextUri: `spotify:artist:${artist.id}` }))` (the existing helper already handles
  `TOKEN_EXPIRED` → refresh and other errors → `controlMessage`).

- [ ] **Step 1: Write/extend tests**

Add cases to `MapView.test.jsx`: clicking `BrowseLibraryButton` toggles
`exploreMode` and swaps which `LeafletMap` props/children appear (mock
`LeafletMap` similarly to however the existing tests already stub
`react-leaflet`/child components — check the current mocking approach first);
`LibraryLoadingBadge` receives `resolvedCount`/`total` from the (mocked)
`useLibraryArtists`; selecting an artist calls `play` with the right
`context_uri` via `runControl`'s existing error paths.

- [ ] **Step 2: Implement the wiring**

```jsx
const { artists, resolvedCount, total } = useLibraryArtists(token);
const [exploreMode, setExploreMode] = useState(false);

async function handleSelectArtist(artist) {
  await runControl(() => play(token, { contextUri: `spotify:artist:${artist.id}` }));
}

// in the JSX, alongside the existing <LeafletMap> and <NowPlayingCard>:
<LeafletMap
  track={track}
  location={location}
  exploreMode={exploreMode}
  libraryArtists={artists}
  onSelectArtist={handleSelectArtist}
/>
<LibraryLoadingBadge resolvedCount={resolvedCount} total={total} />
<BrowseLibraryButton exploreMode={exploreMode} onToggle={() => setExploreMode((v) => !v)} />
```

- [ ] **Step 3: Run full suite, biome, commit**

```bash
npm test
npx biome check --write src/components/MapView.jsx
git add src/components/MapView.jsx src/components/__tests__/MapView.test.jsx
git commit   # Why: ties the explore-mode toggle, background resolution, and click-to-play together; How: MapView owns exploreMode state and useLibraryArtists, routes artist clicks through the existing runControl error handling; Tests: toggle behavior, badge props, click-to-play
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.env.example`
- Modify: `README.md` (if it documents features/env vars — check first)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update `CLAUDE.md` architecture section**

Add a short paragraph after the existing data-flow diagram describing explore
mode: `useLibraryArtists` background-resolves followed artists via
`POST /api/geocode` (cached + globally throttled in Redis), and
`BrowseLibraryButton` swaps `LeafletMap`'s marker layer between now-playing
and the clustered library view. Mention the new files
(`server/geocode.js`, `server/kv.js`, `api/geocode.js`,
`src/useLibraryArtists.js`) in the relevant existing bullet-list style.

- [ ] **Step 2: Add the new env vars to `.env.example`**

```
# Explore mode: server-side geocode cache + rate limiter (Upstash Redis via
# the Vercel Marketplace "Upstash for Redis" integration — auto-injected,
# do not set by hand). Exact names depend on how the integration was
# connected; Redis.fromEnv() supports either pair:
#   KV_REST_API_URL / KV_REST_API_TOKEN
#   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

# Minimum milliseconds between our calls to MusicBrainz/Nominatim (each),
# enforced globally via Redis. Both services' anonymous-use policy caps
# well-behaved clients at 1 req/sec; keep this comfortably above 1000.
GEOCODE_MIN_INTERVAL_MS=1100
```

- [ ] **Step 3: Check `README.md` for anything needing a matching update**

Run: `grep -n "env.example\|OAUTH_SCOPE\|scope" README.md` — update only if
it documents scopes or the env var list (mirror whatever it currently says
about `.env.example`).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .env.example README.md
git commit   # Why: keep docs in sync with the new explore-mode architecture and env vars; How: architecture section addition, .env.example entries; Tests: N/A (docs) — hook still runs npm test, expect green
```

---

### Task 12: Manual verification + open the PR

**Files:** none.

- [ ] **Step 1: Complete Task 0 if not already done**

Confirm Upstash Redis is provisioned and env vars are pulled locally
(`vercel env pull .env`).

- [ ] **Step 2: Re-authenticate**

Log out and back in through the running app so the session picks up the new
`user-follow-read` scope (existing sessions predate it — see spec's migration
note).

- [ ] **Step 3: Start the app and watch the background load**

Run `npm start`. After login, confirm the bottom-left "Loading library X/Y"
badge appears and its counter increases over time, then disappears once
`X === Y`.

- [ ] **Step 4: Explore mode**

Click "Browse library." Confirm the now-playing marker disappears and
clustered library markers appear (matching however much has resolved so
far — don't wait for 100% if it's slow). Zoom in on a cluster; confirm it
breaks into individual artist-image bubbles matching the now-playing bubble's
visual style.

- [ ] **Step 5: Click-to-play**

Click an individual artist marker. Confirm playback starts on that artist
(check the `NowPlayingCard`, still visible top-right, updates to reflect it
within one poll cycle).

- [ ] **Step 6: Toggle back**

Click "Now playing." Confirm the original single-marker/`flyTo` behavior is
back, unchanged from before this feature.

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin library-explore-mode
```

Open a PR to `main` summarizing: adds a toggleable library explore mode
(clustered map of followed artists, click-to-play), backed by a new
cached/rate-limited server-side geocoding endpoint (Upstash Redis). Link the
spec and this plan. Confirm CI (Biome + Vitest) is green before requesting
merge.

---

## Notes for the implementer

- Do **not** touch `src/geo.js` or `AlbumBubble.jsx` — the now-playing path is
  explicitly unchanged (see spec's "Why a separate geocoding path").
- If `@upstash/redis`'s actual serialization behavior differs from what
  Task 5 assumes (auto JSON encode/decode), adjust `server/kv.js` accordingly
  and update its tests — don't guess before checking the installed version's
  behavior against a real call (or its own test suite/examples) once it's in
  `node_modules`.
- The Task 6 `lookupArtistLocation(artistName, { acquireNominatimThrottle })`
  signature change must not alter the zero-arg call path's behavior — the
  Task 4 tests should still pass unmodified after Task 6 lands.
- If, during Task 9, `react-leaflet-cluster`'s actual API differs from the
  sketch above (e.g. `iconCreateFunction` prop name/signature), follow its
  installed version's own type definitions/docs rather than the sketch —
  the sketch is illustrative, not a literal contract.
