# sound-map Phase 1 Design

**Date:** 2026-05-24
**Scope:** MVP — show the currently playing Spotify track as an album art bubble on a world map

---

## Goal

A web app that logs you in with Spotify, then continuously shows where the artist of whatever you're listening to is from — visualised as the album's cover art pinned to a world map.

---

## What's in Phase 1

- Spotify login (Authorization Code flow)
- Poll Spotify every 10 seconds for the currently playing track
- Look up the artist's hometown via MusicBrainz + Nominatim
- Display the album art as a map bubble at those coordinates
- "Nothing playing" message when Spotify is idle

## What's explicitly out of Phase 1

- Saved library / followed artists
- Artist info panel or sidebar
- Play button / start-a-mix
- Token refresh (1-hour session, re-login to continue)
- AWS, Terraform, Kafka (Phase 2+)

---

## Architecture

Two local processes, three external APIs.

```
Browser (React app, port 5173)
    │
    ├─── Spotify API (https://api.spotify.com)
    │         └── GET /me/player/currently-playing
    │               → artist name, album image URL
    │
    ├─── MusicBrainz API (https://musicbrainz.org/ws/2)
    │         └── GET /artist?query=... → begin_area (hometown name)
    │
    ├─── Nominatim API (https://nominatim.openstreetmap.org)
    │         └── GET /search?q=<area name> → lat/lng
    │
    └─── Express server (port 3000)
              └── GET /callback  ← browser redirects here after Spotify login
```

### Why two geo APIs?

Spotify knows your music but not where artists are from. MusicBrainz
(https://musicbrainz.org/doc/MusicBrainz_API) is a free open music encyclopedia
that stores artist origin areas. However it returns area *names*, not coordinates.
Nominatim (https://nominatim.openstreetmap.org/ui/search.html) is OpenStreetMap's
free geocoder — it converts a place name like "Atlanta" into lat/lng. Both are free
with no API key required.

---

## Data Flow

```
1. User opens http://localhost:5173
   App checks for a token in memory → none → show Login button

2. User clicks "Login with Spotify"
   Browser navigates to https://accounts.spotify.com/authorize
     ?client_id=...
     &response_type=code
     &redirect_uri=http://127.0.0.1:3000/callback
     &scope=user-read-currently-playing

3. User approves on Spotify's site
   Spotify redirects browser to http://127.0.0.1:3000/callback?code=XYZ

4. Express server receives the code
   POST https://accounts.spotify.com/api/token
     code=XYZ, client_id, client_secret, redirect_uri
   Receives access_token (valid 60 minutes)
   Redirects browser to http://localhost:5173?token=<access_token>

   NOTE: The client_secret lives only in the Express server's .env file.
   It is never sent to or stored in the browser.

5. React reads the token from the URL query string
   Stores it in a React state variable (memory only — gone on page refresh)
   Starts a polling loop: every 10 seconds, GET /me/player/currently-playing

6. Track is playing → response contains:
   - item.artists[0].name  (e.g. "Kendrick Lamar")
   - item.album.images[0].url  (album art, largest size)

7. Query MusicBrainz:
   GET https://musicbrainz.org/ws/2/artist/?query=artist:"Kendrick Lamar"&fmt=json
   Extract top result's begin-area.name (e.g. "Compton")
   MusicBrainz rate limit: max 1 request/second — we only call this on track change,
   not every poll tick.

8. Query Nominatim:
   GET https://nominatim.openstreetmap.org/search?q=Compton&format=json
   Extract lat/lng from first result and the associated licence
   Nominatim usage policy requires a User-Agent header identifying the app.

9. Map re-centers on those coordinates
   Album art bubble renders at that location

10. Nothing is playing (204 response or empty item)
    → Show message: "Play something on Spotify"
```

---

## Frontend Components

React components are like modules with a visual output. Each owns a slice of
the screen and the data it needs.

```
App                        root — holds token state, currently-playing state
 ├── LoginButton            shown when no token; triggers Spotify auth redirect
 └── MapView                shown when token exists
      ├── LeafletMap        the map canvas — handles tiles, zoom, pan
      └── AlbumBubble       a circular marker: album art + subtle pulse animation
```

**Leaflet** (https://leafletjs.com) is the standard open-source map library.
**React Leaflet** (https://react-leaflet.js.org) wraps it for React.
Map tiles (the actual map imagery) come from OpenStreetMap — free, no API key.

---

## Error Handling

| Situation | Behaviour |
|---|---|
| Nothing playing (HTTP 204) | Show "Play something on Spotify" |
| MusicBrainz artist not found | Keep previous bubble; log a warning |
| Nominatim returns no results | Keep previous bubble; log a warning |
| Spotify HTTP 429 (rate limited) | Back off using Retry-After header value |
| Spotify HTTP 401 (token expired) | Show "Session expired — please log in again" |
| Any other API error | Log to console; do not crash the app |

---

## Spotify Auth Details

- **Flow:** Authorization Code (https://developer.spotify.com/documentation/web-api/tutorials/code-flow)
  — appropriate because we have a server-side component (Express) that can hold the client secret
- **Scope:** `user-read-currently-playing` only
- **Redirect URI:** `http://127.0.0.1:3000/callback` (registered in Spotify Developer Dashboard)
- **Token storage:** memory (React state) — not localStorage, not a cookie, not the server
- **Token refresh:** deferred to Phase 2; session lasts 60 minutes

---

## Tech Stack

| Layer | Technology | Backend analogy |
|---|---|---|
| Language | JavaScript / TypeScript | Like Python or Go |
| Package manager | npm | Like pip (Python) or Maven (Java) |
| Frontend runtime | Node.js | The JS runtime — like the Python interpreter |
| Frontend bundler | Vite | Dev server + compiler; like `uvicorn --reload` for a FastAPI app |
| UI framework | React | Component library for building UIs |
| Map library | Leaflet via React Leaflet | A charting library, but for maps |
| Auth/proxy server | Express | Minimal HTTP server; like Flask |

---

## Local Setup (to be expanded in implementation plan)

```
Prerequisites:
  - Node.js installed (includes npm)
  - Spotify Developer app created with redirect URI http://127.0.0.1:3000/callback
  - .env file at repo root with SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET

Run:
  Terminal 1: npm run dev        (starts Vite frontend on port 5173)
  Terminal 2: node server/index.js  (starts Express on port 3000)

Open: http://localhost:5173
```

---

## Phase 2 Preview

Phase 2 migrates the backend to AWS:
- Express → AWS Lambda + API Gateway
- In-memory state → DynamoDB
- Ad-hoc polling → Kafka (MSK) event stream for currently-playing updates
- Everything provisioned with Terraform
