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

**`src/spotify.js`** — Spotify Web API client: `fetchCurrentlyPlaying(token)` (polls `/me/player/currently-playing`) plus the `play`/`pause`/`skipToNext` player controls. Throws structured errors: `TOKEN_EXPIRED`, `RATE_LIMITED:<seconds>`, `SPOTIFY_ERROR:<status>`. `MapView` handles all three cases. Login starts at the server's `/api/login`, not here.

**`src/geo.js`** — `lookupArtistLocation(artistName)` queries MusicBrainz for the artist's `begin-area` or `area`, then resolves it to lat/lng via Nominatim. Returns `null` on any failure; `MapView` maps `null` to the Pacific Ocean fallback `{ lat: 0, lng: -160 }` rather than leaving the marker at the previous artist's location.

**`src/components/LeafletMap.jsx`** — wraps `react-leaflet`. `MapController` is an inner component that calls `map.flyTo()` imperatively (the only way to trigger Leaflet animations from React state changes). `AlbumBubble` uses a `L.divIcon` with a circular `<img>` as the marker.

### Environment variables

`.env` at repo root (gitignored) — copy from `.env.example`, which documents all
five variables:
```
SPOTIFY_CLIENT_ID        # Spotify app id; read server-side by /api/login
SPOTIFY_CLIENT_SECRET    # server-only; never in client code
COOKIE_ENCRYPTION_KEY    # 32 bytes, base64 — openssl rand -base64 32
REDIRECT_URI             # http://127.0.0.1:3000/api/callback (local)
FRONTEND_URL             # http://127.0.0.1:3000 (local); callback redirects here
```
`vercel dev` also reads `VERCEL_OIDC_TOKEN` from `.env.local` (auto-managed).

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