# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm start          # vercel dev — production shape locally (http://127.0.0.1:3000)
npm run dev        # Vite frontend only (port 5173); no /api
npm run build      # production build (vite build → dist)
npm test           # run Vitest once
npm run test:watch # Vitest in watch mode
```

Local dev requires the Vercel CLI (`npm i -g vercel`, `vercel login`,
`vercel link`). `npm start` runs `vercel dev`, which serves the static SPA and
the `/api/*` serverless functions on one origin — the same shape as production.

To run a single test file:
```bash
npx vitest run src/__tests__/geo.test.js
```

## Architecture

Local dev runs the **production shape** via `vercel dev`: the static Vite SPA
plus the `/api/*` serverless functions on a single origin
(`http://127.0.0.1:3000`). There is no separate backend process.

- **`api/login.js`, `api/callback.js`, `api/refresh.js`, `api/logout.js`** — Vercel serverless functions handling OAuth. They are thin adapters that delegate all logic to `server/auth.js`. `/api/login` mints a one-time CSRF `state` (HttpOnly `oauth_state` cookie) and redirects to Spotify; `/api/callback` verifies it before exchanging the code. `/api/refresh` and `/api/logout` are POST-only.
- **`server/auth.js`** — framework-agnostic auth core: AES-256-GCM seal/open of the session payload `{ rt, iat }` (the `iat` enforces the 30-day session lifetime server-side), `createSession`/`refreshSession`, the authorize-URL builder, and the session/state cookie builders. The Client Secret is used here (server-only), never in the browser.
- **`src/`** — Vite + React SPA. `App.jsx` bootstraps by calling `refreshAccessToken()` (→ `POST /api/refresh`), which exchanges the encrypted `rt` session cookie for a short-lived access token held in React state and passed down to `MapView`.
- **`api/geocode.js`** — Vercel serverless function backing explore mode. Session-gated by actually decrypting and validating the `rt` cookie via `openSession` (the decrypted refresh token itself is discarded — only the "is this a real session" fact is needed, so a forged `rt=x` can't use this as an open proxy in front of the rate-limited upstreams); delegates the actual lookup to `shared/geocode.js` and `server/kv.js`.

### Data flow

```
LandingPage → GET /api/login → sets `oauth_state` cookie → redirect to Spotify /authorize
                                              ↓
Spotify → api/callback.js → verifies `state` → sets encrypted `rt` cookie → redirect to FRONTEND_URL
                                              ↓
App.jsx → POST /api/refresh (sends rt cookie) → access token (React state)
                                              ↓
MapView (polls every few seconds via fetchCurrentlyPlaying)
  → artist changed? → lookupArtistLocation (MusicBrainz → Nominatim)
  → LeafletMap → AlbumBubble (marker at artist's origin)
```

Explore mode overlays a second, independent flow: `useLibraryArtists` runs a
background resolution loop from app boot (regardless of whether explore mode
is showing), keyed on the access token — it fetches the user's followed
artists, then walks them one at a time through `POST /api/geocode`, which is
cached and globally rate-limited in Redis. `BrowseLibraryButton` toggles
`exploreMode`; `LeafletMap` uses that flag to swap its marker layer between
the now-playing bubble and `ArtistClusterLayer`'s clustered view of resolved
library artists, with `LibraryLoadingBadge` showing a `resolvedCount/total`
pill until resolution catches up. Clicking a clustered artist marker starts
that artist's playback via `play(token, { contextUri })` and stays in
explore mode — there's no auto-switch back to now-playing.

**`src/spotify.js`** — Spotify Web API client: `fetchCurrentlyPlaying(token)` (polls `/me/player/currently-playing`) plus the `play`/`pause`/`skipToNext` player controls and `fetchDevices(token)`. Throws structured errors: `TOKEN_EXPIRED`, `RATE_LIMITED:<seconds>`, `SPOTIFY_ERROR:<status>`, and for player calls `PLAYBACK_UNAVAILABLE` (403) / `NO_ACTIVE_DEVICE` (404) / `INSUFFICIENT_SCOPE`. Login starts at the server's `/api/login`, not here.

`PUT /me/player/play` **404s when nothing is currently playing** — the common case on a fresh login, where Spotify is open somewhere but idle. `play()` therefore recovers: on `NO_ACTIVE_DEVICE` it calls `fetchDevices` and retries against a reachable device with `?device_id=`. Only `play` does this — pause/next against no device are meaningless, and waking a client just to pause it would be surprising. Devices with `is_restricted` are skipped (they accept no Web API commands, so targeting one turns a visible 404 into a silent no-op); an already-active device wins when present. If *nothing* is open anywhere, `NO_ACTIVE_DEVICE` is rethrown with its original meaning — no API call can fix that, only the user opening Spotify.

`fetchDevices` needs the **`user-read-playback-state`** scope. It maps 403 to its own `INSUFFICIENT_SCOPE` rather than `PLAYBACK_UNAVAILABLE`, because for a session minted before that scope was added the cause is stale consent, not a missing Premium subscription — telling that user to buy something they already have is worse than saying nothing. `MapView`'s `CONTROL_MESSAGES` turns each of these into an instruction the user can act on; only genuinely unrecognized failures get the generic "Playback control not available".

**`shared/geocode.js`** — the single MusicBrainz → Nominatim implementation, imported by *both* the browser (`MapView`, for now-playing) and the server (`api/geocode.js`, for explore mode); there is no separate `src/geo.js`. `lookupArtistLocation(artistName)` queries MusicBrainz for the artist's `begin-area` or `area`, then resolves it to lat/lng via Nominatim. Returns `null` on any failure; `MapView` maps `null` to the Pacific Ocean fallback `{ lat: 0, lng: -160, unknown: true }` rather than leaving the marker at the previous artist's location — the `unknown` flag makes `LeafletMap` fly out to a wide zoom instead of framing empty ocean. Its optional second argument takes an `acquireNominatimThrottle` callback so the server can rate-limit that hop independently of the MusicBrainz one, plus an `areaCache` (`{ get, set }`) it consults before spending the area-parent request; the browser passes neither and always goes to the network.

Area names are not unique, and Nominatim ranks a free-text search by "importance" — a bare `Aberdeen` resolves to Scotland, so Nirvana landed in the North Sea. The Nominatim query is therefore narrowed with the structure MusicBrainz already has: `countrycodes` from the artist's ISO country, plus the area's **parent area** (`GET /area/<id>?inc=area-rels` → the `part of` relation with `direction: "backward"`), giving `q=Aberdeen, Grays Harbor County&countrycodes=us`. Country alone is not enough — it resolves to Aberdeen, *South Dakota*. That parent lookup is a second MusicBrainz request, so `MUSICBRAINZ_CALLS_PER_LOOKUP` exists for callers to reserve airtime for both hops in one throttle acquisition (`api/geocode.js` holds `throttle:musicbrainz` for 2 × the interval); taking a second lock mid-lookup would deadlock against the one the same request still holds. The parent hop degrades to `null` on any failure — the country filter alone still beats an unqualified search. `placeName` carries the region from Nominatim's `addressdetails` ("Aberdeen, Washington"), requested with `accept-language=en` so labels don't come back localized.

**`src/components/LeafletMap.jsx`** — wraps `react-leaflet`. `MapController` is an inner component that calls `map.flyTo()` imperatively (the only way to trigger Leaflet animations from React state changes). `AlbumBubble` uses a `L.divIcon` with a circular `<img>` as the marker.

**`src/useLibraryArtists.js`** — the explore-mode resolution loop described above: `fetchFollowedArtists` (`GET /me/following?type=artist`, needs the `user-follow-read` scope) then a walk over `POST /api/geocode` driven by `RESOLUTION_CONCURRENCY` workers pulling from one shared queue, retrying `throttled` responses after the server-supplied `retryAfterMs` plus a random spread of up to `RETRY_JITTER_MS`. The jitter is not optional: the server answers every denied caller with the lock's *exact* remaining TTL, so without it concurrent workers wake in lockstep and stampede a lock only one can win.

Concurrency comes from `VITE_RESOLUTION_CONCURRENCY` (build-time, see below), defaulting to **2**. That default is measured, not guessed — a 242-artist cold run at 4 workers never had more than **3** lookups in flight (mean 1.37 while busy) and paid **3.4** throttle denials per lookup against 0.8 for the old sequential loop, so the extra workers bought only denied requests and billable invocations. Reconstruct that from `metrics:geocode:recent` with each sample's `[at - ms, at]` occupancy interval; it is a far less noisy signal than cadence, whose run-to-run spread on identical code was 2552–4829 ms/artist. The floor is ~1500 ms/artist: a typical lookup's work takes ~500 ms but holds the lock for at least `GEOCODE_MIN_INTERVAL_MS`, so the quiet after it is MusicBrainz's 1 req/s budget being honored, not slack more concurrency can fill.

**`server/kv.js`** — Redis cache (`geo:<artistId>`, `not_found` results cached 30 days, `resolved` results cached 180 days — long enough to be effective, bounded so a bad fuzzy-match MusicBrainz result doesn't stick forever) and throttle lock (`throttle:<service>`, via `SET NX PX`) backing `api/geocode.js`.

Several throughput details live here:

- **`geo:area:<mbid>`** caches an area's **parent area** separately from any artist: containment is a fact about geography, shared by every artist from that city, and artists cluster hard in a few cities — so the second MusicBrainz call is usually a Redis hit. A parent lookup that *failed* is deliberately not cached, or a transient MusicBrainz outage would pin itself in Redis for 180 days.
- **`getThrottleRetryMs`** answers a denied caller with the lock's real remaining `PTTL` rather than a constant, because the client sleeps exactly that long before retrying (`useLibraryArtists.js`) — a constant overshoots and leaves the upstream idle.
- **The throttle lock is fenced.** `acquireThrottle` stores a random token as the lock's value and returns it; `releaseThrottleAfter` shortens (or drops) the lock through a Lua compare-and-set that first checks the token still matches. That is what makes `api/geocode.js`'s *early release* safe: it reserves two intervals because it cannot know a lookup's shape in advance, then hands back the second one when only one MusicBrainz call was actually spent. Without the token, a holder whose lease had already lapsed would be shortening whatever lock is there *now* — someone else's.
- **Never hand back the whole remainder.** The one call that did happen still owes a full interval from acquisition, so the remainder is `minIntervalMs - elapsed`. Releasing outright would let a 300ms lookup free the lock immediately and blow the 1 req/s budget.

### Reading the geocode metrics

`recordLookupMetrics` writes running totals and a capped sample of recent lookups. Both are best-effort — measurement can never fail a request. From the Upstash console:

```
HGETALL metrics:geocode          # count, totalMs, totalUpstreamMs, musicBrainzCalls,
                                 # areaCacheHits/Misses, resolved, notFound, cacheHits,
                                 # throttledMusicBrainz, throttledNominatim
LRANGE  metrics:geocode:recent 0 -1   # last 500 lookups
```

Average duration is `totalMs / count`. The samples carry `at`, so the gap between consecutive entries gives the **cadence** — the number the throttle work actually targets, which a per-request duration alone won't tell you. Artist-cache hits and throttle denials only bump counters; sampling them would push real lookups out of the capped list. Constructs the `Redis` client explicitly against `REDIS_KV_REST_API_URL`/`REDIS_KV_REST_API_TOKEN` — **not** `Redis.fromEnv()`, which doesn't recognize the `REDIS_`-prefixed names the Vercel Marketplace Upstash integration injects (see `.env.example`).

### Environment variables

`.env` at repo root (gitignored) — copy from `.env.example`, which documents seven
variables:
```
SPOTIFY_CLIENT_ID           # Spotify app id; read server-side by /api/login
SPOTIFY_CLIENT_SECRET       # server-only; never in client code
COOKIE_ENCRYPTION_KEY       # 32 bytes, base64 — openssl rand -base64 32
REDIRECT_URI                # http://127.0.0.1:3000/api/callback (local)
FRONTEND_URL                # http://127.0.0.1:3000 (local); callback redirects here
GEOCODE_MIN_INTERVAL_MS     # min ms between MusicBrainz/Nominatim calls (default 1100)
VITE_RESOLUTION_CONCURRENCY # browser-side resolution workers (default 2)
```

`VITE_RESOLUTION_CONCURRENCY` is the odd one out: it is read by the **browser**,
so it needs the `VITE_` prefix and Vite substitutes it **at build time**. It is
baked into the bundle — changing it on Vercel needs a redeploy, unlike
`GEOCODE_MIN_INTERVAL_MS`, which `api/geocode.js` reads per invocation. A
`VITE_`-prefixed value is public by construction; never put a secret behind one.
`vercel dev` also reads `VERCEL_OIDC_TOKEN` from `.env.local` (auto-managed),
and `REDIS_KV_REST_API_URL`/`REDIS_KV_REST_API_TOKEN` (the Upstash cache/
throttle backing explore mode, see `server/kv.js`) — both are injected by the
Vercel Marketplace Upstash integration and pulled via `vercel env pull`
rather than set by hand. `Redis.fromEnv()` does **not** work here; see
`.env.example` for why.

## Spotify API rules

- When interacting with the Spotify API use the rules in docs/spotify-api-guidelines.md

## Testing

Tests use **Vitest** with `jsdom` environment. All HTTP calls are mocked via `vi.stubGlobal('fetch', ...)` — no real network calls in tests. `vi.restoreAllMocks()` runs in `beforeEach`.

## Git commits

**Never commit directly to `main`.** All changes go through a feature branch and a PR. Create an appropriately-named branch (lowercase, digits, and hyphens only — no type/prefix notation) before your first commit, and open a PR to merge it into `main`.

Follow the template at `~/.git-template.txt`: each commit message should have **Why**, **How**, and **Tests** sections.

## Dev workflow

A pre-commit hook runs automatically on every `git commit`:

```bash
npx biome check . && npm test
```

If the hook blocks your commit:
- **Biome error:** run `npx biome check --write <file>`, then `git add <file>` and re-commit
- **Test failure:** fix the failing test or the code, then re-commit

Never use `git commit --no-verify` to bypass the hook — fix the issue instead.

The same checks run in GitHub Actions CI on every push and PR. PRs cannot be merged to `main` until CI passes.

## Superpowers

This repo uses https://github.com/obra/superpowers, all info stored in docs/superpowers.

## Goal

Beyond creating a fun app the goal of the author is to learn new technologies, how to be efficient with AI, and more specifically using Superpowers. When making a design decision or when improvements can be made involve the author and explain your reasoning it help the author learn.
Some of the technologies the author is interested in can be found below - it does NOT mean we have to use those technologies:
- Kubernetes
- Terraform / IaC
- AWS Step Function / Serverless
- AWS API Gateway
- AWS Cognito
- Kafka / streaming
- Data plane/control plane