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
  `FRONTEND_URL` with **no token in the URL**.
- **`POST /refresh`** (new): parse `sid` from `req.headers.cookie` (manual parse,
  no `cookie-parser` dependency), look up the refresh token. Call Spotify's token
  endpoint with `grant_type=refresh_token` + the client-secret Basic credentials.
  Return `{ access_token, expires_in }` as JSON. Missing session or Spotify
  rejection → **401**. If Spotify returns a new `refresh_token`, update the stored
  one.
- `res.cookie()` is built into Express; only reading needs manual parsing.

### Security: remove token-in-URL

The access token is no longer placed in the redirect URL (it currently lands in
`?token=…`, leaking into history and referrers). The cookie identifies the
browser instead. `App.jsx` on mount calls `POST /refresh`, which doubles as both
"am I logged in?" bootstrap and token acquisition. The existing `?error=…`
handling for `access_denied` is retained.

### Client

- **`App.jsx`**: owns `refreshAccessToken()` (calls `POST /refresh`, updates
  `token` state). On mount, calls it: `200` → set token; `401` → show
  `LoginButton`. Removes URL-token reading; keeps `?error` handling.
- **`MapView`**: on `TOKEN_EXPIRED`, call `onTokenExpired()` (→
  `refreshAccessToken()`) instead of hard logout. Success updates `token` state →
  the effect re-runs with the new token → polling resumes. Only if `/refresh`
  fails does it fall through to `onSessionExpired()` (real logout).
- **Loop guard + debug:** a poll triggers at most one refresh before giving up
  (no tight refresh loop). A one-line debug log of token presence at the top of
  `poll()` confirms whether empty-token requests occur (the premature-logout
  hypothesis).
- **`spotify.js`**: unchanged — still throws `TOKEN_EXPIRED` on 401.

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

- Extract the Spotify refresh call into a small testable helper; unit-test
  success and Spotify-rejection paths with mocked `fetch`.
- Client: `MapView` gets a 401 → calls `onTokenExpired`, does **not** log out; a
  second 401 *after* a failed refresh → logs out.
- No real network calls, consistent with the existing suite.

## Out of scope (YAGNI)

Proactive refresh timers, a logout endpoint, persistent/Redis session storage,
multi-user concerns. All deferred to "later".
