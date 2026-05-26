# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm start          # run both processes concurrently (recommended for dev)
npm run dev        # Vite frontend only (port 5173)
npm run server     # Express OAuth server only (port 3000)
npm test           # run Vitest once
npm run test:watch # Vitest in watch mode
```

To run a single test file:
```bash
npx vitest run src/__tests__/geo.test.js
```

## Architecture

Two processes must run together:

- **`server/index.js`** — Express server (port 3000) that handles the Spotify OAuth callback. It exchanges the authorization code for an access token using the Client Secret (which cannot be in the browser), then redirects to the frontend with `?token=...` as a query param.
- **`src/`** — Vite + React SPA (port 5173). The token lands in `App.jsx` via `URLSearchParams`, is stored in React state, and passed down to `MapView`.

### Data flow

```
Spotify → server/index.js → ?token=… → App.jsx (state)
                                              ↓
MapView (polls every few seconds via fetchCurrentlyPlaying)
  → artist changed? → lookupArtistLocation (MusicBrainz → Nominatim)
  → LeafletMap → AlbumBubble (marker at artist's origin)
```

**`src/spotify.js`** — two exported functions: `buildAuthUrl()` (constructs the `/authorize` URL) and `fetchCurrentlyPlaying(token)` (polls `/me/player/currently-playing`). Throws structured errors: `TOKEN_EXPIRED`, `RATE_LIMITED:<seconds>`, `SPOTIFY_ERROR:<status>`. `MapView` handles all three cases.

**`src/geo.js`** — `lookupArtistLocation(artistName)` queries MusicBrainz for the artist's `begin-area` or `area`, then resolves it to lat/lng via Nominatim. Returns `null` on any failure; `MapView` maps `null` to the Pacific Ocean fallback `{ lat: 0, lng: -160 }` rather than leaving the marker at the previous artist's location.

**`src/components/LeafletMap.jsx`** — wraps `react-leaflet`. `MapController` is an inner component that calls `map.flyTo()` imperatively (the only way to trigger Leaflet animations from React state changes). `AlbumBubble` uses a `L.divIcon` with a circular `<img>` as the marker.

### Environment variables

`.env` at repo root (gitignored):
```
VITE_SPOTIFY_CLIENT_ID=...    # exposed to browser via import.meta.env
SPOTIFY_CLIENT_SECRET=...     # server-only; never in client code
```

## Spotify API rules

- When interacting with the Spotify API use the rules in docs/spotify-api-guidelines.md

## Testing

Tests use **Vitest** with `jsdom` environment. All HTTP calls are mocked via `vi.stubGlobal('fetch', ...)` — no real network calls in tests. `vi.restoreAllMocks()` runs in `beforeEach`.

## Git commits

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