# Adopt `vercel dev` as the Local Dev Environment — Design

**Date:** 2026-07-24
**Branch:** `local-dev-on-vercel`
**Status:** approved (brainstorming), pending spec review

## Problem

Local development used a two-process model (`npm start` = Vite on `:5173` +
Express on `:3000`), while production runs a different shape (static SPA +
`/api/*` serverless functions on one origin). The two shapes have **different
OAuth callback paths** — Express serves `/callback`, the Vercel function serves
`/api/callback` — so behavior diverges exactly where it is hardest to test.

`vercel dev` already runs the production shape locally (verified: SPA serves,
`POST /api/refresh` with no cookie → `401 {"error":"no_session"}`). The only
reasons it wasn't the local tool:

1. A catch-all SPA rewrite in `vercel.json` swallowed Vite's virtual dev modules
   (`/src/main.jsx`, `/@vite/client`), producing a white page. **Already fixed**
   on this branch — `vercel.json` is now `{}` (the app has no client-side path
   routing, so the fallback was redundant).
2. The client's redirect-URI fallback pointed at the Express `/callback` path,
   which `vercel dev` doesn't serve, so OAuth login never completed.

## Goal

One local dev shape, identical to production: static SPA + `/api/*` serverless
functions on `http://127.0.0.1:3000`, driven by `vercel dev`. Remove the Express
adapter entirely.

## Non-goals

- Changing production behavior (already live and verified).
- Preserving a no-Vercel-CLI local fallback (explicitly declined — full commit
  to `vercel dev`).
- Preview-deploy OAuth (unchanged; still prod + local only, by Spotify's
  exact-redirect-URI rule).

## Design

### 1. Remove the Express adapter

Delete:
- `server/app.js` (Express app)
- `server/index.js` (Express entry / `npm run server` process)
- `server/__tests__/app.test.js`

Keep `server/auth.js` — the framework-agnostic core (AES-256-GCM seal/open,
`createSession`/`refreshSession`, cookie builders). All three `api/*.js`
functions import it; it is unaffected. The ports-and-adapters *core* survives;
only the redundant second adapter is removed.

Remove the now-unused `concurrently` devDependency.

### 2. Client redirect-URI fallback — `src/spotify.js`

Change the fallback default:

```
- import.meta.env.VITE_REDIRECT_URI ?? "http://127.0.0.1:3000/callback";
+ import.meta.env.VITE_REDIRECT_URI ?? "http://127.0.0.1:3000/api/callback";
```

So `vercel dev` completes login even if `VITE_REDIRECT_URI` is unset locally.
Update the corresponding assertion in `src/__tests__/spotify.test.js`.

Use `127.0.0.1`, **not** `localhost` — Spotify rejects `localhost` for loopback
redirect URIs.

### 3. `package.json` scripts

- Remove `server`.
- `start` → `vercel dev` (the one local dev command).
- Keep `dev` (`vite`) for quick UI-only iteration (no `/api`).
- Keep `build`, `test`, `test:watch`.

### 4. `vite.config.js`

- Remove the `server.proxy` `/api` → `http://127.0.0.1:3000` block (its target,
  Express, is gone; `vercel dev` serves `/api` itself).
- Remove `"server/index.js"` from the coverage `exclude` disallow-list (file
  deleted). After this, `server/` contains only `auth.js`, already fully covered.

### 5. `vercel.json`

Already `{}` on this branch (white-page fix). No further change.

### 6. Environment & `.gitignore`

Local `.env` gains (non-secret, loopback):

```
REDIRECT_URI=http://127.0.0.1:3000/api/callback
VITE_REDIRECT_URI=http://127.0.0.1:3000/api/callback
FRONTEND_URL=http://127.0.0.1:3000
```

`.gitignore`: keep the Vercel-CLI-added `.vercel` ignore (required — holds the
project link). Adjust the broad `.env*` so a committed template is allowed:

```
.env*
!.env.example
```

Update the existing (already git-tracked) **`.env.example`** to be the canonical
template listing every required variable — client id, client secret, cookie key,
and the three URLs — with placeholder values and a short comment per var. This
pairs with the README rewrite so a new contributor knows exactly what to set.
(The `!.env.example` rule is belt-and-suspenders: the file is already tracked so
git won't ignore it, but the explicit exception documents the intent and keeps
`git add`/`status` predictable.)

#### `.env*` consistency audit

Several `.env*` files exist and have drifted. The plan must audit **all** of
them against `.env.example` and reconcile each to an *intentional, documented*
variable set — they need not be identical (different contexts need different
subsets), but every difference must be deliberate and explained. Current state
and target:

| File | Tracked? | Intended variables | Notes |
|------|----------|---------------------|-------|
| `.env.example` | yes | **all** app vars (placeholders) | canonical reference |
| `.env` | no (gitignored) | all app vars (real values) | local/`vercel dev`; **add the 3 new URL vars** |
| `.env.local` | no (gitignored) | `VERCEL_OIDC_TOKEN` only | Vercel-managed, auto-pulled — do **not** hand-edit or duplicate app vars here |
| `.env.test` | yes (tracked, no secret) | minimal set the `test` mode actually needs | vitest loads `.env.test`; confirm which vars tests read at import time vs. `vi.stubEnv`, then trim/justify |

Deliverable: after the audit, each file's variable set matches this table, and
`.env.example` header comments state which file supplies which variable and why
`.env.local`/`.env.test` differ. `.env.test` is committed and safe (no secret —
only `VITE_SPOTIFY_CLIENT_ID`); keep it that way (never add secrets to a tracked
env file).

### 7. Cookie `Secure` flag under local http

`api/callback.js` and `api/refresh.js` currently hardcode `secure: true`, so the
`rt` cookie always carries `Secure`. Under `vercel dev` the app is served over
**http** on `127.0.0.1`. Browsers (Chrome, Firefox, Safari) treat `127.0.0.1`
and `localhost` as *potentially-trustworthy secure contexts* and **do** accept
`Secure` cookies there over http — so this is expected to work unchanged.

Plan must **verify the `rt` cookie is actually stored** after login under
`vercel dev`. If any target browser refuses it, the fallback is to derive the
flag from the deployment scheme rather than hardcoding it — e.g.
`secure = (process.env.FRONTEND_URL ?? "").startsWith("https")` — which yields
`false` locally (`http://127.0.0.1:3000`) and `true` in production
(`https://…`), with tests for both branches. Do **not** add this conditional
speculatively; only if verification shows a stored-cookie failure.

### 8. Spotify dashboard (manual, operator step)

Replace the local redirect URI `http://127.0.0.1:3000/callback` with
`http://127.0.0.1:3000/api/callback`. Keep the production URI
`https://sound-map-iota.vercel.app/api/callback`.

### 9. Documentation

- **`CLAUDE.md`** — Commands section (drop `npm run server`; `npm start` is now
  `vercel dev`) and Architecture/data-flow (two-process → single `vercel dev`
  origin; remove Express references; note `server/auth.js` is the shared core
  used by the `api/` functions).
- **`README.md`** — Setup step 1 redirect URI → `/api/callback`; step 2 `.env`
  lists all required vars (or points at `.env.example`); "Running locally"
  becomes a single `vercel dev` flow (prereq: `npm i -g vercel`, `vercel login`,
  `vercel link`); open `http://127.0.0.1:3000`.
- Scan `docs/superpowers/plans/2026-07-23-vercel-operator-setup.md` and the
  deployment docs for stale Express references; update as needed.

## Trade-off

`vercel dev` cold-starts each serverless function per request, so it is somewhat
slower than the old persistent Express server. Accepted in exchange for
local == production.

## Verification

1. `npm test` green (deleted `app.test.js` removed from the suite; coverage still
   passes with `server/` = `auth.js` only).
2. `npx biome check .` clean.
3. `vercel dev`: SPA loads (no white page), `GET /src/main.jsx` returns
   JavaScript, login with an allowlisted account completes, the `rt` cookie is
   **actually stored** by the browser (see §7 — `HttpOnly`, `SameSite=Lax`,
   `Secure` present but accepted on `127.0.0.1`), and `POST /api/refresh` with
   that cookie → `200`.
