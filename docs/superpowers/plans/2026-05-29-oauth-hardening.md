# OAuth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two security gaps in the Spotify OAuth flow — add a CSRF-protecting `state` parameter, and stop leaking the access token through the URL query string — without changing what the app can do.

**Architecture:** Move login *initiation* onto the server. Today the browser builds the `/authorize` URL itself and the server only handles `/callback`; that leaves no place to mint and verify a `state`. After this change: the browser links to the server's new `GET /login`, which generates a random `state`, stores it in an **httpOnly cookie** (same origin as the server, so no cross-origin cookie pain), and 302-redirects to Spotify. `GET /callback` verifies the returned `state` against the cookie before exchanging the code. On success the server redirects the token back in the **URL fragment** (`#token=…`) instead of the query string, so the token never reaches server access logs or the `Referer` header. The browser still reads the token in JS (it needs it to call Spotify directly), so the fragment — not an httpOnly cookie — is the right carrier here.

**Tech Stack:** Express 4, `cookie-parser` (new dep), `supertest` (new dev dep) for endpoint tests, Vitest, React.

---

## Why these specific choices (for the author)

- **Why `state` at all?** Without it, an attacker can trick your browser into completing *their* OAuth flow (login CSRF), binding your session to their account — or replay a stolen `code`. `state` is the standard mitigation: a random value you set before redirecting and verify on return.
- **Why move login to the server?** `state` must be created and checked by the *same* party. The server owns `/callback`, so it must also own the start of the flow to set the cookie that `/callback` later verifies. The frontend's `buildAuthUrl()` goes away.
- **Why fragment, not an httpOnly cookie, for the token?** An httpOnly cookie is more secure but unreadable by JS — and this SPA calls the Spotify API *directly from the browser* with the token. Hiding it in a cookie would force every Spotify call to proxy through the server (a much bigger change). The fragment keeps the token JS-readable while keeping it out of logs/`Referer`. *If you later proxy Spotify through the server, revisit this and switch to an httpOnly cookie.* This trade-off is worth discussing in review.
- **Why does the client no longer need `VITE_SPOTIFY_CLIENT_ID`?** Once the server builds the authorize URL, the client ID lives only on the server. We keep the `.env` var name (the server reads it) but the browser no longer references it.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `server/oauth.js` | Pure helpers: `generateState()`, `buildAuthorizeUrl(state)`, `parseStateCookie(header)` | Create |
| `server/index.js` | Add `GET /login`; verify `state` + use fragment in `/callback`; cookie middleware | Modify |
| `src/spotify.js` | Remove `buildAuthUrl()`/client-id usage; keep `fetchCurrentlyPlaying` | Modify |
| `src/components/LoginButton.jsx` | Link to the server's `/login` instead of `buildAuthUrl()` | Modify |
| `src/App.jsx` | Read token/error from `location.hash` instead of `location.search` | Modify |
| `src/__tests__/spotify.test.js` | Drop `buildAuthUrl` tests | Modify |
| `server/__tests__/oauth.test.js` | Unit-test the pure helpers | Create |
| `server/__tests__/index.test.js` | Endpoint tests via supertest | Create |
| `README.md`, `CLAUDE.md` | Document the new flow + redirect URI | Modify |

> **Note on test config:** `vite.config.js` sets `test.coverage.include` to only `src/geo.js` and `src/spotify.js`. Server tests live under `server/__tests__/` and run fine, but won't count toward coverage thresholds. Task 6 adds `server/oauth.js` to the `include` list so its coverage is measured.

---

### Task 1: Pure OAuth helpers (server-side)

**Files:**
- Create: `server/oauth.js`, `server/__tests__/oauth.test.js`

- [ ] **Step 1: Write the failing test `server/__tests__/oauth.test.js`**

```js
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, generateState, parseStateCookie } from "../oauth.js";

describe("generateState", () => {
  it("returns a long random hex string", () => {
    const s = generateState();
    expect(s).toMatch(/^[a-f0-9]{32,}$/);
  });

  it("returns a different value each call", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes client_id, redirect_uri, scope, response_type and the given state", () => {
    const url = buildAuthorizeUrl("abc123", {
      clientId: "my-id",
      redirectUri: "http://127.0.0.1:3000/callback",
      scope: "user-read-currently-playing",
    });
    expect(url).toContain("https://accounts.spotify.com/authorize");
    expect(url).toContain("client_id=my-id");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=abc123");
    expect(url).toContain(encodeURIComponent("http://127.0.0.1:3000/callback"));
    expect(url).toContain("scope=user-read-currently-playing");
  });
});

describe("parseStateCookie", () => {
  it("extracts the sm_oauth_state value from a Cookie header", () => {
    expect(parseStateCookie("sm_oauth_state=xyz; other=1")).toBe("xyz");
  });

  it("returns null when the cookie is absent", () => {
    expect(parseStateCookie("other=1")).toBeNull();
    expect(parseStateCookie(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run server/__tests__/oauth.test.js`
Expected: FAIL with "Failed to resolve import ../oauth.js".

- [ ] **Step 3: Create `server/oauth.js`**

```js
import { randomBytes } from "node:crypto";

export const STATE_COOKIE = "sm_oauth_state";

export function generateState() {
  return randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(state, { clientId, redirectUri, scope }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export function parseStateCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === STATE_COOKIE) return rest.join("=");
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run server/__tests__/oauth.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/oauth.js server/__tests__/oauth.test.js
git commit -m "feat: pure OAuth helpers for state + authorize URL

Why: groundwork for CSRF-protected login; pure functions are unit-testable.
How: generateState (crypto random), buildAuthorizeUrl (adds state),
parseStateCookie.
Tests: server/__tests__/oauth.test.js (6 cases)."
```

---

### Task 2: Add `/login` and verify `state` in `/callback`

This task restructures `server/index.js`. To make it endpoint-testable, export the Express `app` and only call `app.listen` when run directly.

**Files:**
- Modify: `server/index.js` (add `cookie-parser`)
- Create: `server/__tests__/index.test.js`

- [ ] **Step 1: Install dependencies**

```bash
npm install cookie-parser
npm install -D supertest
```

- [ ] **Step 2: Write the failing endpoint test `server/__tests__/index.test.js`**

```js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server module reads env + builds the app at import time, so set env first.
process.env.VITE_SPOTIFY_CLIENT_ID = "test-client-id";
process.env.SPOTIFY_CLIENT_SECRET = "test-secret";

const { app } = await import("../index.js");
const request = (await import("supertest")).default;

describe("GET /login", () => {
  it("sets a state cookie and redirects to Spotify with a matching state", async () => {
    const res = await request(app).get("/login");
    expect(res.status).toBe(302);
    const location = res.headers.location;
    expect(location).toContain("accounts.spotify.com/authorize");

    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/sm_oauth_state=/);
    expect(setCookie.toLowerCase()).toContain("httponly");

    const cookieState = setCookie.match(/sm_oauth_state=([^;]+)/)[1];
    expect(location).toContain(`state=${cookieState}`);
  });
});

describe("GET /callback", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("redirects with access_denied when state does not match the cookie", async () => {
    const res = await request(app)
      .get("/callback?code=abc&state=ATTACKER")
      .set("Cookie", "sm_oauth_state=REAL");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=access_denied");
  });

  it("redirects with access_denied when Spotify returns an error", async () => {
    const res = await request(app).get("/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=access_denied");
  });

  it("exchanges the code and redirects the token in the URL fragment on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "TOKEN123" }),
      }),
    );
    const res = await request(app)
      .get("/callback?code=goodcode&state=MATCH")
      .set("Cookie", "sm_oauth_state=MATCH");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("#token=TOKEN123");
    expect(res.headers.location).not.toContain("?token=");
  });

  it("clears the state cookie after handling the callback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "TOKEN123" }),
      }),
    );
    const res = await request(app)
      .get("/callback?code=goodcode&state=MATCH")
      .set("Cookie", "sm_oauth_state=MATCH");
    const setCookie = (res.headers["set-cookie"] || []).join(";");
    expect(setCookie).toContain("sm_oauth_state=;");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run server/__tests__/index.test.js`
Expected: FAIL (no `/login` route; `app` not exported; token still in query).

- [ ] **Step 4: Rewrite `server/index.js`**

```js
import "dotenv/config";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import { STATE_COOKIE, buildAuthorizeUrl, generateState } from "./oauth.js";

const app = express();
app.use(cookieParser());

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const FRONTEND_URL = "http://localhost:5173";
const SCOPE = "user-read-currently-playing";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing VITE_SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env");
  process.exit(1);
}

const STATE_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: false, // dev over http://127.0.0.1; set true behind HTTPS in prod
  maxAge: 10 * 60 * 1000, // 10 minutes — the login round-trip is short-lived
  path: "/",
};

app.get("/login", (_req, res) => {
  const state = generateState();
  res.cookie(STATE_COOKIE, state, STATE_COOKIE_OPTS);
  res.redirect(buildAuthorizeUrl(state, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scope: SCOPE }));
});

app.get("/callback", async (req, res) => {
  const { code, error, state } = req.query;
  const expectedState = req.cookies?.[STATE_COOKIE] ?? null;
  res.clearCookie(STATE_COOKIE, { path: "/" });

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}/#error=access_denied`);
  }

  // CSRF protection: the returned state must match the one we set before redirecting.
  if (!state || !expectedState || state !== expectedState) {
    console.error("OAuth state mismatch");
    return res.redirect(`${FRONTEND_URL}/#error=access_denied`);
  }

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  let tokenResponse;
  try {
    tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
  } catch (err) {
    console.error("Token exchange network error:", err);
    return res.redirect(`${FRONTEND_URL}/#error=token_exchange_failed`);
  }

  if (!tokenResponse.ok) {
    console.error("Token exchange failed:", tokenResponse.status, await tokenResponse.text());
    return res.redirect(`${FRONTEND_URL}/#error=token_exchange_failed`);
  }

  try {
    const { access_token } = await tokenResponse.json();
    if (!access_token) {
      return res.redirect(`${FRONTEND_URL}/#error=token_exchange_failed`);
    }
    // Fragment, not query: the token never reaches server logs or the Referer header.
    return res.redirect(`${FRONTEND_URL}/#token=${encodeURIComponent(access_token)}`);
  } catch (err) {
    console.error("Failed to parse token response:", err);
    return res.redirect(`${FRONTEND_URL}/#error=token_exchange_failed`);
  }
});

// Only listen when run directly (not when imported by tests).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(3000, "127.0.0.1", () => {
    console.log("OAuth server listening on http://127.0.0.1:3000");
  });
}

export { app };
```

- [ ] **Step 5: Run the endpoint tests to verify they pass**

Run: `npx vitest run server/__tests__/index.test.js`
Expected: PASS (6 cases across the two describes).

- [ ] **Step 6: Commit**

```bash
git add server/index.js server/__tests__/index.test.js package.json package-lock.json
git commit -m "feat: server-initiated login with CSRF state, token via fragment

Why: add OAuth state to prevent login CSRF; keep the access token out of
URL query strings (logs/Referer).
How: new GET /login sets an httpOnly state cookie and redirects to Spotify;
/callback verifies state and returns the token in the URL fragment; app is
exported for supertest.
Tests: server/__tests__/index.test.js."
```

---

### Task 3: Point the login link at the server

**Files:**
- Modify: `src/components/LoginButton.jsx`

> If Plan 1 (design adoption) has already run, `LoginButton` is the branded screen and the only change is the link target. If not, it's the original button. Either way, replace the `buildAuthUrl()` usage.

- [ ] **Step 1: Update the import and the anchor**

In `src/components/LoginButton.jsx`, remove the `buildAuthUrl` import and link directly to the server's `/login` endpoint. Replace:

```jsx
import { buildAuthUrl } from "../spotify.js";
```
with nothing (delete that import), and define near the top of the file:

```jsx
const LOGIN_URL = "http://127.0.0.1:3000/login";
```

Then change the anchor's `href={buildAuthUrl()}` to `href={LOGIN_URL}`.

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: build succeeds (no remaining reference to `buildAuthUrl`).

- [ ] **Step 3: Commit**

```bash
git add src/components/LoginButton.jsx
git commit -m "feat: start login at the server /login endpoint

Why: login initiation must live where the state cookie is set/verified.
How: link to http://127.0.0.1:3000/login instead of a client-built URL.
Tests: npm run build succeeds."
```

---

### Task 4: Read token/error from the URL fragment

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Update `src/App.jsx` to parse `location.hash`**

Replace the `useEffect` block with one that reads the fragment:

```jsx
  useEffect(() => {
    // Token/error now arrive in the URL fragment (#token=… / #error=…),
    // which is never sent to servers or logged.
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const t = params.get("token");
    const e = params.get("error");
    if (t) setToken(decodeURIComponent(t));
    if (e) setError(e);
    if (t || e) window.history.replaceState({}, "", "/");
  }, []);
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/App.jsx
git commit -m "feat: read token/error from URL fragment

Why: pair with the server now redirecting via #token=/#error=.
How: parse window.location.hash instead of location.search.
Tests: npm run build succeeds."
```

---

### Task 5: Remove `buildAuthUrl` from the client

`buildAuthUrl` (and the client-side `VITE_SPOTIFY_CLIENT_ID` requirement) is dead now that the server owns the authorize URL.

**Files:**
- Modify: `src/spotify.js`, `src/__tests__/spotify.test.js`

- [ ] **Step 1: Delete `buildAuthUrl` and the client-id constant from `src/spotify.js`**

Remove the top of the file:

```js
const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
if (!CLIENT_ID)
  throw new Error("VITE_SPOTIFY_CLIENT_ID is not set — check your .env file");
const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const SCOPE = "user-read-currently-playing";

export function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}
```

The file should now start directly with `export async function fetchCurrentlyPlaying(token) {`.

- [ ] **Step 2: Drop the `buildAuthUrl` tests from `src/__tests__/spotify.test.js`**

Remove the import of `buildAuthUrl` (keep `fetchCurrentlyPlaying`) and delete the entire `describe("buildAuthUrl", ...)` block. The import line becomes:

```js
import { fetchCurrentlyPlaying } from "../spotify.js";
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all suites pass (the `fetchCurrentlyPlaying` and server tests remain; `buildAuthUrl` tests are gone).

- [ ] **Step 4: Run Biome to catch unused vars**

Run: `npx biome check .`
Expected: clean (no unused-import/variable errors).

- [ ] **Step 5: Commit**

```bash
git add src/spotify.js src/__tests__/spotify.test.js
git commit -m "refactor: drop client-side buildAuthUrl

Why: the server now owns the authorize URL and the client id.
How: removed buildAuthUrl + VITE_SPOTIFY_CLIENT_ID usage from the client and
its tests.
Tests: npm test green; npx biome check . clean."
```

---

### Task 6: Coverage config + docs

**Files:**
- Modify: `vite.config.js`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Measure coverage on `server/oauth.js`**

In `vite.config.js`, change `coverage.include` from:

```js
      include: ["src/geo.js", "src/spotify.js"],
```
to:

```js
      include: ["src/geo.js", "src/spotify.js", "server/oauth.js"],
```

- [ ] **Step 2: Verify coverage thresholds still pass**

Run: `npx vitest run --coverage`
Expected: PASS; `server/oauth.js` appears in the coverage table at high % (it's exercised by both test files).

- [ ] **Step 3: Update `README.md` and `CLAUDE.md`**

- `README.md`: note that login starts at the server (`/login`) and that the only required redirect URI is still `http://127.0.0.1:3000/callback`.
- `CLAUDE.md`: in the data-flow section, replace "redirects to the frontend with `?token=...`" with the `#token=…` fragment + `state` verification description; update the `spotify.js` bullet (no more `buildAuthUrl`).

- [ ] **Step 4: Commit**

```bash
git add vite.config.js README.md CLAUDE.md
git commit -m "chore: cover server/oauth.js and document the hardened flow

Why: keep coverage meaningful and docs accurate after the OAuth change.
How: added server/oauth.js to coverage include; updated README/CLAUDE.md.
Tests: npx vitest run --coverage passes thresholds."
```

---

## Self-Review

- **Spec coverage:** `state` generated + set as httpOnly cookie (T1, T2), verified in `/callback` with mismatch → `access_denied` (T2 test), token returned via fragment not query (T2 test asserts `#token=` and not `?token=`), client reads fragment (T4), login starts at server (T2 `/login`, T3 link), dead `buildAuthUrl` removed (T5), docs (T6). ✅
- **Placeholders:** none — full code for helpers, server, and all edits. ✅
- **Type consistency:** `STATE_COOKIE` constant defined in `oauth.js` and imported in `index.js`; `buildAuthorizeUrl(state, { clientId, redirectUri, scope })` signature identical in test (T1) and call site (T2); cookie name `sm_oauth_state` consistent across `oauth.js`, server tests, and the `/callback` clear. ✅
- **Note:** Task 2's success test stubs `fetch`; this matches the existing test convention (`vi.stubGlobal('fetch', …)`). The real `fetch` is Node 18+ global, which the server relies on at runtime. ✅
