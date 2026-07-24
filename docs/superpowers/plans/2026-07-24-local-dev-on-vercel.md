# Adopt `vercel dev` as Local Dev Environment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `vercel dev` the single local dev environment so the local shape is identical to production (static SPA + `/api/*` serverless functions on `http://127.0.0.1:3000`), removing the Express adapter.

**Architecture:** Delete the Express HTTP adapter (`server/app.js`, `server/index.js`) while keeping the framework-agnostic core `server/auth.js` that the `api/*.js` serverless functions import. Point the client redirect-URI fallback and local env at `/api/callback`. Reconcile `.env*` files against a canonical `.env.example`. Update tooling and docs.

**Tech Stack:** Vite + React SPA, Vercel serverless functions (`api/`), Node `crypto` auth core, Vitest, Biome.

**Companion spec:** `docs/superpowers/specs/2026-07-24-local-dev-on-vercel-design.md`

## Global Constraints

- Never commit to `main`. Work happens on branch `local-dev-on-vercel`; finish with a PR to `main`.
- Commit messages follow `~/.git-template.txt`: **Why / How / Tests** sections, plus `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- The pre-commit hook runs `npx biome check . && npm test` on every commit. Never bypass with `--no-verify`. If Biome flags a file, run `npx biome check --write <file>`, `git add`, re-commit.
- Coverage bar (vite.config.js) is per-file: statements 90, branches 75, functions 100. Every included file must meet it.
- Redirect URIs use `127.0.0.1`, never `localhost` (Spotify rejects `localhost` for loopback).
- The current working tree already has two uncommitted changes from earlier this session: `vercel.json` set to `{}` and `.gitignore` with `.vercel`/`.env*` appended by the Vercel CLI. These are committed in Task 3.

---

### Task 1: Point the client redirect-URI fallback at `/api/callback`

**Files:**
- Modify: `src/spotify.js:25`
- Test: `src/__tests__/spotify.test.js:21`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildAuthUrl()` unchanged signature; its default `redirect_uri` (when `VITE_REDIRECT_URI` is unset) becomes `http://127.0.0.1:3000/api/callback`.

- [ ] **Step 1: Update the failing test assertion**

In `src/__tests__/spotify.test.js`, change line 21:

```js
    expect(url).toContain(encodeURIComponent("http://127.0.0.1:3000/api/callback"));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/spotify.test.js -t "returns a Spotify authorize URL"`
Expected: FAIL — actual URL still contains `%2Fcallback`, not `%2Fapi%2Fcallback`.

- [ ] **Step 3: Update the fallback in `src/spotify.js`**

Change line 25:

```js
    import.meta.env.VITE_REDIRECT_URI ?? "http://127.0.0.1:3000/api/callback";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/spotify.test.js`
Expected: PASS (both `buildAuthUrl` tests).

- [ ] **Step 5: Commit**

```bash
git add src/spotify.js src/__tests__/spotify.test.js
git commit   # Why/How/Tests message: fallback now targets the vercel dev /api/callback path
```

---

### Task 2: Remove the Express adapter and its tooling

**Files:**
- Delete: `server/app.js`, `server/index.js`, `server/__tests__/app.test.js`
- Modify: `package.json` (scripts + dependencies)
- Modify: `vite.config.js` (remove `/api` proxy; remove `server/index.js` from coverage `exclude`)

**Interfaces:**
- Consumes: `server/auth.js` remains and is imported by `api/callback.js`, `api/refresh.js`, `api/logout.js` — do not touch it.
- Produces: `npm start` now means `vercel dev`; `npm run server` no longer exists.

- [ ] **Step 1: Delete the Express adapter files**

```bash
git rm server/app.js server/index.js server/__tests__/app.test.js
```

- [ ] **Step 2: Update `package.json` scripts**

Replace the `scripts` block with (removes `server`, `start` becomes `vercel dev`):

```json
  "scripts": {
    "dev": "vite",
    "start": "vercel dev",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "postinstall": "npx simple-git-hooks"
  },
```

- [ ] **Step 3: Remove orphaned dependencies from `package.json`**

Delete `"express"` and `"dotenv"` from `dependencies`, and `"concurrently"` and `"supertest"` from `devDependencies`. Resulting blocks:

```json
  "dependencies": {
    "leaflet": "^1.9.4",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-leaflet": "^4.2.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.15",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@vitejs/plugin-react": "^5.2.0",
    "@vitest/coverage-v8": "^4.1.7",
    "jsdom": "^24.0.0",
    "simple-git-hooks": "^2.13.1",
    "vite": "^8.0.14",
    "vitest": "^4.1.7"
  }
```

- [ ] **Step 4: Sync the lockfile**

Run: `npm install`
Expected: `package-lock.json` updates, removing express/dotenv/concurrently/supertest and their orphaned transitive deps. No errors.

- [ ] **Step 5: Remove the `/api` proxy and dead coverage exclude from `vite.config.js`**

Change the `server` block from:

```js
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
```

to:

```js
  server: {
    host: "127.0.0.1",
  },
```

And delete this line from the coverage `exclude` array (the file no longer exists):

```js
        "server/index.js", // process entry point (env check + listen)
```

- [ ] **Step 6: Run the full suite + coverage**

Run: `npm test`
Expected: PASS. Test count drops (the `server/app.test.js` suite is gone). Coverage still passes — `server/` now contains only the fully-covered `auth.js`.

- [ ] **Step 7: Biome check**

Run: `npx biome check .`
Expected: clean. If not, `npx biome check --write .` then re-check.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit   # Why: local shape now == prod; How: deleted Express adapter + orphaned deps, start=vercel dev, dropped /api proxy; Tests: npm test green, app.test.js removed
```

---

### Task 3: Config & `.env*` consistency

**Files:**
- Commit: `vercel.json` (already `{}` in working tree)
- Modify: `.gitignore`
- Modify: `.env.example` (git-tracked template)
- Modify (local, NOT committed): `.env` — add the three URL vars
- Verify: `.env.test` (git-tracked) — confirm it needs no change

**Interfaces:**
- Consumes: nothing.
- Produces: `.env.example` is the canonical variable list referenced by README and CLAUDE.md.

- [ ] **Step 1: Tidy `.gitignore`**

Replace the env-related lines (the Vercel CLI left `.env*` appended below older, now-redundant `.env` rules) so the whole file reads:

```
node_modules/
dist/
coverage/

# Superpowers visual-companion / brainstorm scratch (transient HTML mockups)
.superpowers/

# Env files: ignore all real env files. .env.example (template) and .env.test
# (fake test creds, needed for `npm test`) are intentionally committed.
.env*
!.env.example
!.env.test

.DS_Store

# Vercel CLI project link (vercel link / vercel dev)
.vercel
```

- [ ] **Step 2: Verify the tracked env files are still tracked and the intended ones stay ignored**

Run:
```bash
git check-ignore -v .env .env.local && echo "IGNORED (expected)"
git ls-files --error-unmatch .env.example .env.test && echo "TRACKED (expected)"
```
Expected: `.env` and `.env.local` report as ignored; `.env.example` and `.env.test` report as tracked.

- [ ] **Step 3: Rewrite `.env.example` as the canonical template**

Overwrite `.env.example` with every required variable, placeholders, and per-var comments:

```
# Copy to .env and fill in real values. See README.md for where each comes from.

# Spotify app credentials — https://developer.spotify.com/dashboard
VITE_SPOTIFY_CLIENT_ID=your_client_id_here      # exposed to the browser (expected)
SPOTIFY_CLIENT_SECRET=your_client_secret_here   # server-only; never in client code

# Session-cookie encryption key — generate with: openssl rand -base64 32
# (must decode to exactly 32 bytes; the app throws a clear error otherwise)
COOKIE_ENCRYPTION_KEY=generate_with_openssl_rand_base64_32

# `vercel dev` runs the production shape on ONE origin: http://127.0.0.1:3000
# REDIRECT_URI and VITE_REDIRECT_URI MUST be identical and registered in Spotify.
REDIRECT_URI=http://127.0.0.1:3000/api/callback
VITE_REDIRECT_URI=http://127.0.0.1:3000/api/callback
FRONTEND_URL=http://127.0.0.1:3000

# Not listed here (managed automatically, do not add by hand):
#   .env.local  — VERCEL_OIDC_TOKEN, pulled by `vercel dev`/`vercel link`
#   .env.test   — VITE_SPOTIFY_CLIENT_ID only (fake), loaded by vitest in test mode
```

- [ ] **Step 4: Add the three URL vars to the local `.env` (NOT committed)**

Append to `.env` (gitignored — local machine only):

```bash
cat >> .env <<'EOF'
REDIRECT_URI=http://127.0.0.1:3000/api/callback
VITE_REDIRECT_URI=http://127.0.0.1:3000/api/callback
FRONTEND_URL=http://127.0.0.1:3000
EOF
```

Verify names (values hidden): `grep -oE '^[A-Z_]+=' .env | tr -d '='` should list all six: `VITE_SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY`, `REDIRECT_URI`, `VITE_REDIRECT_URI`, `FRONTEND_URL`.

- [ ] **Step 5: Audit `.env.test`**

Confirm `.env.test` contains only `VITE_SPOTIFY_CLIENT_ID` and that the test suite passes with it unchanged (the `buildAuthUrl` fallback test *requires* `VITE_REDIRECT_URI` to be absent so it exercises the default — do NOT add it here).

Run: `npm test`
Expected: PASS. If any test fails for a missing env var, add ONLY that var to `.env.test` with a fake value and note why; otherwise leave `.env.test` unchanged.

- [ ] **Step 6: Commit the tracked config changes**

```bash
git add vercel.json .gitignore .env.example
# (add .env.test only if Step 5 changed it)
git commit   # Why: vercel dev needs {} rewrite + reconciled env files; How: commit vercel.json={}, tidy .gitignore, canonical .env.example, env audit; Tests: npm test green
```

Note: `.env` is gitignored, so its local edits are intentionally NOT in this commit.

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-07-23-vercel-operator-setup.md` (stale Express references)

**Interfaces:** none (docs only).

- [ ] **Step 1: Rewrite `README.md` Setup + Running sections**

- Step 1 redirect URI: change `http://127.0.0.1:3000/callback` → `http://127.0.0.1:3000/api/callback`.
- Step 2 `.env`: point at `.env.example` (`cp .env.example .env`) and list all six vars, or say "copy `.env.example` and fill in values".
- "Running locally": replace the two-terminal (`node server/index.js` + `npm run dev`) instructions with the `vercel dev` flow. Replacement text:

```markdown
## Running locally

Local dev runs the same shape as production (static SPA + `/api/*` serverless
functions on one origin) via the Vercel CLI:

```bash
npm i -g vercel      # once
vercel login         # once
vercel link          # once — link this folder to your Vercel project
npm start            # runs `vercel dev` on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000, click **Login with Spotify**, and start playing
something. (`npm run dev` still runs the Vite frontend alone for UI-only work,
but `/api/*` won't be available.)
```

- [ ] **Step 2: Update `CLAUDE.md` Commands section**

Replace the commands block so it reflects the new scripts:

```bash
npm start          # vercel dev — production shape locally (http://127.0.0.1:3000)
npm run dev        # Vite frontend only (port 5173); no /api
npm run build      # production build (vite build → dist)
npm test           # run Vitest once
npm run test:watch # Vitest in watch mode
```

- [ ] **Step 3: Update `CLAUDE.md` Architecture section**

- Remove the "Two processes must run together" framing and the `server/index.js` Express description.
- State: local dev uses `vercel dev` (single origin, production shape). `server/auth.js` is the framework-agnostic auth core imported by the `api/*.js` serverless functions (`callback`, `refresh`, `logout`).
- Update the data-flow diagram: `Spotify → api/callback.js → sets rt cookie → redirects to FRONTEND_URL`; the SPA calls `POST /api/refresh` for an access token.

- [ ] **Step 4: Scan the operator runbook for stale references**

Run: `grep -n "npm start\|server/index\|Express\|:5173\|/callback\b" docs/superpowers/plans/2026-07-23-vercel-operator-setup.md`
Update any line that describes the old two-process/Express local model or the `/callback` (non-`/api`) path so it matches the `vercel dev` reality.

- [ ] **Step 5: Verify docs build-agnostic (no code impact) and commit**

Run: `npx biome check .` (docs don't affect it, but the hook will run `npm test` too).
```bash
git add README.md CLAUDE.md docs/superpowers/plans/2026-07-23-vercel-operator-setup.md
git commit   # Why: docs must match vercel-dev workflow; How: rewrote README running section, CLAUDE.md commands+architecture, fixed runbook refs; Tests: N/A (docs) — hook green
```

---

### Task 5: Spotify dashboard + end-to-end verification (manual operator step)

**Files:** none (dashboard + local runtime verification).

**Interfaces:** none.

- [ ] **Step 1: Register the local `/api/callback` redirect URI in Spotify**

In the Spotify Developer dashboard → the app → Settings → Redirect URIs:
- Add `http://127.0.0.1:3000/api/callback`.
- Remove the old `http://127.0.0.1:3000/callback` (Express path, no longer served).
- Keep the production URI `https://sound-map-iota.vercel.app/api/callback`.
Save.

- [ ] **Step 2: Start `vercel dev`**

Run (own terminal): `npm start` (→ `vercel dev`). Wait for `Ready! Available at http://127.0.0.1:3000`.

- [ ] **Step 3: Verify module serving (white-page regression check)**

Run: `curl -s -o /dev/null -w "%{content_type}\n" http://127.0.0.1:3000/src/main.jsx`
Expected: a JavaScript content-type (e.g. `text/javascript`), NOT `text/html`.

- [ ] **Step 4: Complete an OAuth login**

In a browser at http://127.0.0.1:3000, log in with an allowlisted Spotify account. Expected: redirected back to the app (not the login screen), map loads.

- [ ] **Step 5: Verify the `rt` cookie is actually stored (spec §7)**

Devtools → Application → Cookies → `http://127.0.0.1:3000`: confirm an `rt` cookie exists with `HttpOnly` and `SameSite=Lax`. It will carry `Secure`; browsers accept it on `127.0.0.1`.
- If `rt` is ABSENT: this is the spec §7 fallback trigger. Stop and implement the scheme-derived `secure` flag (`secure = (process.env.FRONTEND_URL ?? "").startsWith("https")`) in `api/callback.js` and `api/refresh.js`, with tests for both branches, then re-verify. (Only do this if the cookie is genuinely rejected.)

- [ ] **Step 6: Verify authenticated refresh**

With the `rt` cookie present, in devtools console or via curl with the cookie:
Run: `curl -s -w "\n%{http_code}\n" -X POST http://127.0.0.1:3000/api/refresh --cookie "rt=<value-from-devtools>"`
Expected: `200` with an `access_token` in the body (NOT `401 no_session`).

---

### Task 6: Open the pull request

- [ ] **Step 1: Push the branch**

```bash
git push -u origin local-dev-on-vercel
```

- [ ] **Step 2: Open the PR to `main`**

Create a PR summarizing: adopt `vercel dev` as the single local dev environment, remove the Express adapter, reconcile `.env*` files, update docs. Include the spec/plan links. Confirm CI (Biome + Vitest) is green before requesting merge.

---

## Notes for the implementer

- Do **not** touch `server/auth.js` — it is the shared core the serverless functions depend on.
- The `vercel.json = {}` and `.gitignore` changes are already in the working tree from an earlier session; Task 3 commits them (don't re-create them).
- If coverage fails after Task 2, check that `server/index.js` was removed from the `exclude` list AND that no new uncovered file slipped into `server/`.
