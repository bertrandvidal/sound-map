# Logging & Full Test Coverage — Design

**Date:** 2026-07-21
**Status:** Approved, pending implementation
**Branch:** token-refresh (continues the token-refresh work)

## Problem / Goal

Three improvements to the token-refresh branch:

1. **Poll cadence too aggressive.** Polling every 3s is more than needed and closer
   to Spotify's rate limits than necessary. Slow it to 5s.
2. **Hard to follow what the app is doing.** There is little runtime logging on
   either tier, so diagnosing behavior (session bootstrap, refresh, polling)
   means guessing. Add informative logging — without ever logging secrets.
3. **Uneven test coverage.** Pure logic modules are unit-tested and
   coverage-gated, but the React components and the Express route wiring have no
   tests at all. Bring every file under test/coverage, except a documented set
   that genuinely should not be tested.

## 1. Poll interval

`src/components/MapView.jsx`: `const POLL_MS = 3_000;` → `5_000`. No other change.

## 2. Logging

**Approach:** plain `console.info` / `console.warn` / `console.error` with a
consistent tier prefix (`[server]`, `[app]`, `[poll]`). No logging library and
no dedicated logger module — YAGNI for a personal app, and a logger module would
invite low-value "assert console was called" tests.

**Never logged (enforced in review):** access tokens, refresh tokens, the `sid`
cookie value, the client secret, the OAuth `code`, and any raw `Cookie` or
`Authorization` header. Approved to log: track and artist names (already shown
on screen; the user's own playback), event names, HTTP status codes, and the
count of active sessions.

**Backend** (`server/app.js`):
- callback received
- token exchange failed (status only)
- session created — logs the active-session count, **never the `sid`**
- refresh requested
- refresh succeeded
- refresh failed → session evicted

**Frontend:**
- `src/App.jsx`: bootstrapping session → restored vs. no active session (login);
  token expired → refreshing → recovered vs. logged out
- `src/components/MapView.jsx`: now playing `artist – track`, nothing playing,
  artist changed → location lookup, rate-limited → retry in Ns, token expired →
  refresh. This **replaces** the ad-hoc `import.meta.env.DEV` `[poll] token
  present:` debug line added during the token-refresh work.
- `src/auth.js`: requesting token refresh (no token value).

**Verbosity gating:** verbose frontend `info` logs are gated behind
`import.meta.env.DEV`; `warn` and `error` are always on. Keeps production builds
quiet. Backend logs are always on (dev tool).

**Testing of logging:** no tests assert on log output (that would be
mock-testing). The log lines are covered incidentally by the component/route
tests that exercise those code paths.

## 3. Tests & coverage

### New dev dependencies
- `@testing-library/react` + `@testing-library/jest-dom` — React component tests
- `supertest` — Express route tests

React-18-compatible versions will be pinned; `npm ci` is run to confirm peer
deps resolve cleanly before pushing.

### Vitest setup
- Add `src/test/setup.js` importing `@testing-library/jest-dom/vitest` (matchers)
  and add it to `test.setupFiles` in `vite.config.js`. React Testing Library
  auto-cleanup is active because `test.globals` is already `true`.

### Server refactor for testability
Extract the Express app from `server/index.js` into a factory:
- **`server/app.js`** — exports `createApp({ clientId, clientSecret })` returning
  `{ app, sessions }`. Contains all routes and the `sessions` Map. Imports the
  helpers from `server/auth.js`.
- **`server/index.js`** — shrinks to: read env, validate (`process.exit(1)` if
  missing), `const { app } = createApp({...})`, `app.listen(...)`. A thin process
  entry point.

This lets supertest drive the app in-process and seed/reset `sessions` per test
without opening a socket.

### New tests
- **`server/__tests__/app.test.js`** (supertest, `fetch` mocked):
  - `GET /callback` with `?error` → 302 to `FRONTEND_URL?error=access_denied`
  - `GET /callback` success → sets `sid` cookie, 302 to `FRONTEND_URL` with no
    token in the location
  - `POST /api/refresh` with no cookie → 401
  - `POST /api/refresh` with a seeded session → 200 `{ access_token }`
  - `POST /api/refresh` where the Spotify refresh fails → 401 and the session is
    evicted
- **`src/__tests__/App.test.jsx`** (RTL; child components stubbed via `vi.mock`
  so App is a true unit; `./auth.js` mocked):
  - bootstrap resolves a token → renders the map (stub)
  - bootstrap rejects → renders `LoginButton` (stub)
  - `onTokenExpired` path: refresh resolves → stays on map; refresh rejects →
    shows login
- **`src/components/__tests__/MapView.test.jsx`** (RTL + `vi.useFakeTimers`;
  `./LeafletMap.jsx`, `../geo.js`, `../spotify.js` mocked):
  - a poll 401 calls `onTokenExpired` and does **not** hard-log-out
  - a rate-limit error schedules a retry
  - the `refreshingRef` guard: overlapping 401 polls trigger only one refresh
- **`src/components/__tests__/LoginButton.test.jsx`** (RTL):
  - renders the Spotify auth link (via `buildAuthUrl`)
  - renders the error message when an `error` prop is set

### Coverage configuration
Switch from a hand-maintained include-list to include-globs plus a documented
exclude list, in `vite.config.js`:

```
include: ['src/**/*.{js,jsx}', 'server/**/*.js']
exclude:
  '**/__tests__/**', '**/*.test.{js,jsx}', 'src/test/setup.js',  // test scaffolding
  'src/main.jsx',                 // React DOM entry point (createRoot+render); no logic
  'server/index.js',              // process entry point (env check + listen); logic in server/app.js
  'src/components/LeafletMap.jsx', // react-leaflet wrapper; needs real canvas/map sizing jsdom lacks
  'src/components/AlbumBubble.jsx' // builds a Leaflet divIcon; same canvas/DOM constraint
```

**Why the excluded files are excluded (per the "tell me why" ask):**
- `src/main.jsx` / `server/index.js` — process/DOM bootstrap entry points with no
  branching logic; a test would exercise the framework, not our code.
- `src/components/LeafletMap.jsx` / `src/components/AlbumBubble.jsx` — thin
  wrappers over Leaflet, which requires a real canvas and measurable map
  container that jsdom does not provide; testing them tests the library. If we
  later want them covered, a jsdom canvas shim is the path.

### Thresholds
Pure-logic modules keep the strict bar. React components are hard to drive to
100% function coverage (inline handlers, `.catch`/`.finally` callbacks) without
contrived tests, so the `.jsx` glob gets a realistic scoped threshold. Concretely
in `vite.config.js` `coverage.thresholds`:
- global (applies to the pure `.js` modules): statements 90, branches 75,
  functions 100 (unchanged)
- `'src/**/*.jsx'`: statements 80, branches 70, functions 85

(Exact scoped-threshold syntax per Vitest v8 will be confirmed during
implementation; intent is: pure modules strict, components realistic.)

## Out of scope (YAGNI)

A logging library or logger module, log-assertion tests, testing the Leaflet
wrappers, structured/JSON logs, log levels config. All deferred.

## Verification

`npx biome check . && npm test` green with the new coverage thresholds met; a
manual `npm start` sanity check that the new logs read clearly and expose no
secrets.
