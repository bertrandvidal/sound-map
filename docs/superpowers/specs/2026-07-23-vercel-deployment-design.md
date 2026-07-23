# Deploy sound-map to Vercel

**Date:** 2026-07-23
**Status:** Approved design, pending implementation plan

## Goal

Make sound-map available online — reachable at a public HTTPS URL that a
hand-picked set of people can log into with their own Spotify accounts —
while keeping the app simple, free, and its local dev loop intact.

A secondary, explicit goal (per `CLAUDE.md`) is learning: this design favors
a clean, transferable architecture (ports-and-adapters) and a real serverless
deployment over the lowest-effort possible path.

## Constraints & decisions

These were settled during brainstorming and are not open for re-litigation
during planning:

1. **Audience: Spotify Development Mode, ≤5 users.** Spotify now caps
   Development Mode apps at **5 users**, each added by hand (name + email) in
   the Spotify dashboard. We deploy publicly but stay in Development Mode with
   a manual allowlist. We do **not** pursue Extended Quota Mode (an external
   Spotify app-review dependency we don't control).

2. **Platform: Vercel.** The built Vite SPA is served as static assets; the two
   server-side endpoints (OAuth callback, token refresh) run as Vercel
   serverless functions under `/api`. Chosen for first-class Vite support, a
   genuinely free hobby tier, automatic HTTPS + domain, and zero servers to
   operate.

3. **Local dev is preserved unchanged.** The existing `npm start` loop
   (Express on `:3000` + Vite on `:5173` with an `/api` proxy) keeps working
   exactly as today. Achieved via ports-and-adapters (below), not by rewriting
   local dev to match production.

4. **Token storage: encrypted in an httpOnly cookie. No datastore.** The
   Spotify refresh token is sealed with AES-256-GCM using a server-only key and
   stored in an `httpOnly; Secure; SameSite=Lax` cookie. This is the
   "encrypted stateless session" pattern (iron-session / Rails encrypted
   cookies). It removes the in-memory `Map` (which cannot survive serverless)
   without introducing a database. Accepted tradeoff: no cheap per-user
   server-side revocation — acceptable for a 5-user app, with Spotify's own
   "revoke app access" as the backstop.

5. **Free `*.vercel.app` domain.** A custom domain is out of scope (can be
   added later with no code change).

6. **OAuth works on production + local only, not preview URLs.** Spotify only
   honors exactly-registered redirect URIs; preview deployments get random
   URLs. We accept this rather than engineering around it. Auth is tested
   locally or against production.

## Architecture: one core, two adapters

All authentication logic is framework-agnostic and lives in the core
(`server/auth.js`, extended). Express (local) and Vercel functions (prod) are
thin, interchangeable transport adapters over that core. Neither adapter owns
business logic; each unwraps its request/response shape and delegates.

```
                 ┌─────────────────────────────┐
                 │  server/auth.js  (the core)  │
                 │  exchangeAuthCode()          │  ← new (lifted from app.js)
                 │  exchangeRefreshToken()      │  ← exists
                 │  sealToken() / openToken()   │  ← new: AES-256-GCM
                 │  buildSessionCookie()        │  ← new
                 │  parseCookies()              │  ← exists
                 └─────────────────────────────┘
                    ▲                        ▲
       local  ┌─────┴──────┐        prod ┌───┴────────────┐
              │ server/    │             │ api/callback.js│
              │ app.js     │             │ api/refresh.js │
              │ (Express)  │             │ (Vercel fns)   │
              └────────────┘             └────────────────┘
```

The Vitest suite continues to test the core directly, so the existing coverage
thresholds are adapter-agnostic and unaffected by which adapter is deployed.

## Components & changes

### `server/auth.js` — the core (grows)
- **`sealToken(plaintext)` / `openToken(sealed)`** — AES-256-GCM via Node's
  built-in `crypto`, keyed by `COOKIE_ENCRYPTION_KEY`. GCM gives confidentiality
  and integrity (tamper → decrypt throws). No new dependency.
- **`exchangeAuthCode(code)`** — lift the authorization-code → token exchange
  currently inline in `app.js` into a testable core function.
- **`buildSessionCookie(sealed)` / a cookie-clearing helper** — centralize the
  `httpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…` attributes so both
  adapters emit identical cookies.
- Keep existing `exchangeRefreshToken`, `parseCookies`.

### `server/app.js` — local adapter (simplifies)
- Callback and `/api/refresh` become thin wrappers over the core.
- **Delete the in-memory `sessions` `Map`** and all references to it.
- Replace hardcoded `REDIRECT_URI` / `FRONTEND_URL` constants with env vars so
  the same core is portable across environments.

### `api/callback.js`, `api/refresh.js` — production adapters (new)
- ~5–10 lines each. Unwrap Vercel's Express-like `(req, res)` and call the core.
- `callback`: `exchangeAuthCode` → `sealToken` → set cookie → redirect to `/`.
- `refresh`: read cookie → `openToken` → `exchangeRefreshToken` → return access
  token; **if Spotify rotated the refresh token, re-issue the cookie**.

### `vercel.json` (new)
- SPA-fallback rewrite: `"/((?!api/).*)" → "/index.html"` so client-side routes
  and asset loading work while `/api/*` is left to the functions.

### `src/` — unchanged
- `src/auth.js` already calls the relative path `/api/refresh`; once deployed
  same-origin on Vercel it behaves identically to local (where the Vite proxy
  provides the same single-origin view).

## Auth flow (production)

1. Login → Spotify → redirect to `https://<app>.vercel.app/api/callback`.
2. `api/callback.js`: `exchangeAuthCode(code)` → `sealToken(refreshToken)` →
   `Set-Cookie: rt=<sealed>; HttpOnly; Secure; SameSite=Lax; Path=/` → redirect
   to `/`.
3. SPA boots → `POST /api/refresh` → `openToken(cookie)` →
   `exchangeRefreshToken` → returns access token. On rotation, re-issues the
   cookie via a fresh `Set-Cookie`.
4. Logout → cookie cleared (`Max-Age=0`).

Local flow is unchanged from today (Express `:3000`, Vite proxy, same core).

## Configuration & secrets

- **Vercel environment variables:** `VITE_SPOTIFY_CLIENT_ID`,
  `SPOTIFY_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` (generate once via
  `openssl rand -base64 32`), `REDIRECT_URI`, `FRONTEND_URL`.
- **Spotify dashboard:** register **both** redirect URIs —
  `http://127.0.0.1:3000/callback` (local, unchanged) and
  `https://<app>.vercel.app/api/callback` (prod). Add ≤5 users under
  *Users and Access*.

## Deployment & CI/CD

- Connect the GitHub repo to Vercel: push to `main` auto-deploys to production;
  PRs produce preview URLs.
- The existing Biome + Vitest GitHub Action still gates merges to `main`; Vercel
  builds afterward.
- Preview-URL OAuth limitation is accepted (see decision 6).

## Guided operator setup (explicit deliverable)

The implementation plan MUST include a **dedicated, interactive walkthrough
task/agent** that runs the author through the human-in-the-loop, click-through
setup that cannot be expressed as repo code. It covers, at minimum:

- Creating the Vercel account and project (importing the GitHub repo).
- Installing/authenticating the **Vercel CLI**, and using **`vercel dev`** to
  run the production shape locally.
- The **Vercel MCP server / agent integration** — what it is, whether to set it
  up, and how it helps drive Vercel from within the agent workflow.
- Setting the Vercel environment variables (including generating
  `COOKIE_ENCRYPTION_KEY`).
- Adding the production redirect URI **and** the ≤5 allowlisted users in the
  Spotify dashboard.
- How preview deployments behave, and the practical workflow given that OAuth
  only completes on prod + local.

This task is distinct from the code-change workstreams: it is a checklist-style,
pause-and-confirm guide for the human, not an automated code change.

## Testing

- Core: `sealToken`/`openToken` round-trip, tamper-detection (mutated ciphertext
  → throws), and `exchangeAuthCode` — unit-tested to the existing per-file 90%
  bar in `vite.config.js`.
- Adapters stay thin enough to sit near the global coverage floor.
- No new test infrastructure; all HTTP stays mocked per existing conventions.

## Out of scope (YAGNI)

Custom domain, any datastore, revocation/denylists, rate-limiting, monitoring,
and the Spotify Extended Quota application.
