# Spotify Token Refresh — Design

**Date:** 2026-07-21
**Status:** Approved, pending implementation

## Problem

The app "logs out" quickly during normal use. Two intertwined issues:

1. **No refresh mechanism (certain).** `server/index.js` destructures only
   `access_token` from Spotify's token response, discarding `refresh_token` and
   `expires_in`. The access token lives in browser React state only. When it
   expires (Spotify access tokens last 3600 s), `fetchCurrentlyPlaying` gets a
   `401`, `MapView` calls `onSessionExpired`, and the user is bounced to login
   with no way to recover short of a full re-login. The app therefore cannot
   survive past one hour, let alone run in the background.

2. **Premature logout (observed, ~<2 min).** Observed `401 "Access token
   missing"` — Spotify's message for a request with an *empty* bearer token
   (`Bearer null`/`Bearer undefined`), distinct from an *expired* token. The
   current architecture treats any 401 as a permanent, unrecoverable logout
   (`MapView.jsx:39` → `App.jsx:22`). The exact first trigger of the empty-token
   request is not fully explained by code reading alone; a debug log will
   confirm it. Regardless of trigger, the redesign turns "one 401 = logout" into
   "one 401 = recover", which fixes this whole class of bug.

## Goal

Let the app keep polling for hours (background playback) without re-login, by
giving the browser a way to re-mint short-lived access tokens, while keeping the
long-lived refresh token off the browser entirely.

## Architecture

The server gains a small session/identity layer (control plane) that holds the
durable refresh token and vends short-lived access tokens to the polling loop
(data plane). The browser holds only a disposable 1-hour access token it can
always re-mint via the server.

```
Spotify → server /callback → stores refresh_token server-side, sets httpOnly cookie
                           → redirects to "/" (NO token in URL)
                                              ↓
App.jsx on mount → POST /refresh (cookie) → 200 {access_token} → use it
                                          → 401 → show LoginButton
                                              ↓
MapView polls; on 401 → onTokenExpired() → POST /refresh → new token → resume
                                                         → 401 → real logout
```

### Design decisions (from brainstorming)

- **Refresh token home:** server-side only; never sent to the browser.
- **Server storage:** in-memory `Map<sessionId, { refreshToken }>`. Zero deps.
  Trade-off: server restart wipes sessions → re-login (acceptable in dev). Clean
  seam for a real store later.
- **Refresh trigger:** reactive on 401 (no proactive timers). Simplest path that
  directly replaces "one 401 = logout" with "one 401 = recover".

## Components

### Server (`server/index.js`)

- `const sessions = new Map()` — `sessionId → { refreshToken }`.
- **`GET /callback`** (extended): destructure `access_token`, `refresh_token`,
  `expires_in`. Generate `sessionId` via `crypto.randomUUID()`,
  `sessions.set(sessionId, { refreshToken })`, set httpOnly `SameSite=Lax`
  cookie `sid` (path `/`, `secure=false` for http localhost). Redirect to
  `FRONTEND_URL` (now `http://127.0.0.1:5173`) with **no token in the URL**.
- **`POST /api/refresh`** (new, reached via the Vite proxy): parse `sid` from
  `req.headers.cookie` (manual parse, no `cookie-parser` dependency), look up the
  refresh token. Call Spotify's token endpoint with `grant_type=refresh_token` +
  the client-secret Basic credentials. Return `{ access_token, expires_in }` as
  JSON. Missing session or Spotify rejection → **401**. If Spotify returns a new
  `refresh_token`, update the stored one.
- Pure helpers extracted to **`server/auth.js`** (`parseCookies(header)`,
  `exchangeRefreshToken(refreshToken, { clientId, clientSecret })`) so the
  network/parse logic is unit-testable without starting the Express listener.
- `res.cookie()` is built into Express; only reading needs manual parsing.

### Dev cross-origin cookies (Vite proxy)

The frontend (`:5173`) and OAuth server (`:3000`) are different origins, so a
naive cross-origin `fetch` to `:3000` would not send an httpOnly session cookie
(and would need CORS). Solution:

- **Vite dev proxy:** `vite.config.js` proxies `/api` → `http://127.0.0.1:3000`.
  The SPA calls the refresh endpoint at the **relative** path `/api/refresh`, so
  from the browser's view it is same-origin; Vite forwards it to the server. No
  CORS configuration is needed.
- **Align on `127.0.0.1`:** Spotify's `redirect_uri` must be `127.0.0.1` (not
  `localhost`), so `/callback` runs on `127.0.0.1:3000` and sets the `sid` cookie
  for host `127.0.0.1` (cookies ignore port). The frontend is therefore accessed
  at `http://127.0.0.1:5173` (Vite `server.host` set accordingly, and
  `FRONTEND_URL` changes from `localhost` to `127.0.0.1`) so the same
  `127.0.0.1` cookie is presented on the same-origin `/api/refresh` call.
- **Cookie attributes:** httpOnly, `SameSite=Lax`, `Secure=false` (http
  localhost), path `/`. Lax is sufficient because the SPA only ever issues
  same-origin requests to itself, and `/callback` arrives via top-level
  navigation.
- The server route is therefore `POST /api/refresh` (proxied); `GET /callback`
  stays a direct top-level hit from Spotify's redirect.

### Security: remove token-in-URL

The access token is no longer placed in the redirect URL (it currently lands in
`?token=…`, leaking into history and referrers). The cookie identifies the
browser instead. `App.jsx` on mount calls `POST /refresh`, which doubles as both
"am I logged in?" bootstrap and token acquisition. The existing `?error=…`
handling for `access_denied` is retained.

### Client

Following the codebase pattern (coverage gates only pure modules; React
components are thin glue), the new logic lives in two testable pure modules and
the components stay thin:

- **`src/auth.js`** (new, pure): `refreshAccessToken()` → `POST /api/refresh`
  with `credentials: "include"`; returns the access-token string on `200`;
  throws `SESSION_EXPIRED` on `401`/failure. Mirrors `spotify.js` structure.
- **`src/pollError.js`** (new, pure): `classifyPollError(message)` → a small
  descriptor (`{ type: "refresh" }`, `{ type: "retry", seconds }`, or
  `{ type: "error" }`) so `MapView`'s catch block is a thin dispatch that can be
  tested without rendering.
- **`App.jsx`** (thin glue): on mount calls `refreshAccessToken()` — `200` → set
  token; throw → show `LoginButton`. Provides `onTokenExpired`, which calls
  `refreshAccessToken()` and either updates `token` state (recover) or triggers
  `onSessionExpired` (real logout). Removes URL-token reading; keeps `?error`.
- **`MapView`** (thin glue): uses `classifyPollError`; on `type: "refresh"`
  `await`s `onTokenExpired()` instead of hard logout, with a one-refresh-per-poll
  guard (no tight loop). Adds a one-line debug log of token presence at the top
  of `poll()` to confirm whether empty-token requests occur (the premature-logout
  hypothesis).
- **`spotify.js`**: unchanged — still throws `TOKEN_EXPIRED` on 401.

Both new modules are added to the Vitest coverage `include` list and must meet
the existing thresholds (functions 100%).

## Error handling

| Situation | Behavior |
|-----------|----------|
| Poll 401, refresh 200 | Use new token, resume polling |
| Poll 401, refresh 401 | Real logout (`onSessionExpired`) |
| Refresh loop within one poll | Guarded: at most one refresh attempt |
| `/refresh` with no/invalid session cookie | 401 → LoginButton |
| Spotify returns rotated refresh_token | Stored refresh token updated |
| 429 rate limit | Unchanged (existing backoff) |

## Testing (Vitest, all `fetch` mocked)

- **`server/auth.js`** (`server/__tests__/auth.test.js`): `parseCookies` parses a
  `Cookie` header into an object (and handles absent/empty headers);
  `exchangeRefreshToken` returns `{ accessToken, expiresIn, refreshToken }` on a
  Spotify `200` and throws on a Spotify error response.
- **`src/auth.js`** (`src/__tests__/auth.test.js`): `refreshAccessToken` returns
  the access token on `200`; throws `SESSION_EXPIRED` on `401`.
- **`src/pollError.js`** (`src/__tests__/pollError.test.js`): `classifyPollError`
  maps `TOKEN_EXPIRED` → `refresh`, `RATE_LIMITED:10` → `retry`/`seconds`, and
  anything else → `error`.
- The recover-vs-logout decision is thereby covered by pure units
  (`classifyPollError` routes a 401 to refresh; `refreshAccessToken` throwing
  `SESSION_EXPIRED` drives the real logout); the thin `App`/`MapView` glue is
  verified during the manual run — consistent with the existing coverage scope,
  which gates only pure modules.
- No real network calls, consistent with the existing suite.

## Out of scope (YAGNI)

Proactive refresh timers, a logout endpoint, persistent/Redis session storage,
multi-user concerns. All deferred to "later".
