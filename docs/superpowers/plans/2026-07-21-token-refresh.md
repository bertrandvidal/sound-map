# Spotify Token Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the app keep polling Spotify for hours without re-login by keeping the refresh token server-side and re-minting access tokens on demand.

**Architecture:** The Express server gains an in-memory session layer that holds the long-lived refresh token, sets an httpOnly cookie, and vends short-lived access tokens via `POST /api/refresh`. The browser holds only a disposable access token and, on a 401, refreshes instead of logging out. A Vite dev proxy makes the refresh call same-origin so the cookie is sent.

**Tech Stack:** Express, Vite + React 18, Vitest (jsdom), Biome. All HTTP mocked in tests via `vi.stubGlobal("fetch", ...)`.

## Global Constraints

- No new npm dependencies (cookie parsing is manual; `res.cookie()` is built into Express).
- Follow the git commit template `~/.git-template.txt`: **Why / How / Tests** sections on every commit.
- Pre-commit hook runs `npx biome check . && npm test`; never bypass with `--no-verify`. On a Biome error run `npx biome check --write <file>`.
- Tests never make real network calls; mock `fetch` per the existing suite style.
- Coverage thresholds (Vitest): statements 90, branches 75, functions 100 — applied to files in the coverage `include` list.
- Spotify `redirect_uri` stays `http://127.0.0.1:3000/callback` (must be `127.0.0.1`, never `localhost`).
- The dev frontend is accessed at `http://127.0.0.1:5173` (not `localhost:5173`) so the `127.0.0.1` session cookie is presented.

---

### Task 1: Server auth helpers (`server/auth.js`)

Pure, testable helpers for cookie parsing and the Spotify refresh-token exchange, extracted so they can be unit-tested without starting the Express listener.

**Files:**
- Create: `server/auth.js`
- Test: `server/__tests__/auth.test.js`

**Interfaces:**
- Produces:
  - `parseCookies(header: string | undefined): Record<string, string>`
  - `exchangeRefreshToken(refreshToken: string, opts: { clientId: string, clientSecret: string }): Promise<{ accessToken: string, expiresIn: number, refreshToken: string }>` — throws `Error("REFRESH_FAILED:<status>")` on a non-OK Spotify response.

- [ ] **Step 1: Write the failing tests**

Create `server/__tests__/auth.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeRefreshToken, parseCookies } from "../auth.js";

describe("parseCookies", () => {
  it("returns an empty object for a missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("parses a single cookie", () => {
    expect(parseCookies("sid=abc123")).toEqual({ sid: "abc123" });
  });

  it("parses multiple cookies and trims whitespace", () => {
    expect(parseCookies("sid=abc123; other=xyz")).toEqual({
      sid: "abc123",
      other: "xyz",
    });
  });
});

describe("exchangeRefreshToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns tokens on a Spotify 200, keeping the old refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "new-access", expires_in: 3600 }),
      }),
    );
    const result = await exchangeRefreshToken("refresh-abc", {
      clientId: "id",
      clientSecret: "secret",
    });
    expect(result).toEqual({
      accessToken: "new-access",
      expiresIn: 3600,
      refreshToken: "refresh-abc",
    });
  });

  it("prefers a rotated refresh token when Spotify returns one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access",
            expires_in: 3600,
            refresh_token: "rotated",
          }),
      }),
    );
    const result = await exchangeRefreshToken("refresh-abc", {
      clientId: "id",
      clientSecret: "secret",
    });
    expect(result.refreshToken).toBe("rotated");
  });

  it("throws when Spotify rejects the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    await expect(
      exchangeRefreshToken("bad", { clientId: "id", clientSecret: "secret" }),
    ).rejects.toThrow("REFRESH_FAILED:400");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: FAIL — cannot resolve `../auth.js`.

- [ ] **Step 3: Write the implementation**

Create `server/auth.js`:

```js
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export async function exchangeRefreshToken(refreshToken, { clientId, clientSecret }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`REFRESH_FAILED:${response.status}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token ?? refreshToken,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/__tests__/auth.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/auth.js server/__tests__/auth.test.js
git commit   # Why/How/Tests message: server-side cookie parse + refresh-token exchange helpers
```

---

### Task 2: Wire the server (sessions, cookie, `/api/refresh`)

Add the in-memory session store, extend `/callback` to keep the refresh token and set the cookie (no token in the URL), and add the `POST /api/refresh` endpoint. This is integration glue verified by the server starting and Task 1's helper tests; no new unit test (matches the codebase pattern of not unit-testing the Express wiring).

**Files:**
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `parseCookies`, `exchangeRefreshToken` from `server/auth.js` (Task 1).
- Produces: `POST /api/refresh` → `{ access_token, expires_in }` on 200, `401` JSON on no/invalid session.

- [ ] **Step 1: Replace `server/index.js` with the wired version**

```js
import { randomUUID } from "node:crypto";
import "dotenv/config";
import express from "express";
import { exchangeRefreshToken, parseCookies } from "./auth.js";

const app = express();

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const FRONTEND_URL = "http://127.0.0.1:5173";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing VITE_SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env",
  );
  process.exit(1);
}

// sessionId -> { refreshToken }. In-memory: a server restart clears sessions
// (re-login), which is acceptable for local dev. Swap for a real store later.
const sessions = new Map();

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?error=access_denied`);
  }

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
    "base64",
  );

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
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
  }

  if (!tokenResponse.ok) {
    console.error(
      "Token exchange failed:",
      tokenResponse.status,
      await tokenResponse.text(),
    );
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
  }

  let refreshToken;
  try {
    const body = await tokenResponse.json();
    refreshToken = body.refresh_token;
    if (!refreshToken) {
      return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
    }
  } catch (err) {
    console.error("Failed to parse token response:", err);
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, { refreshToken });

  res.cookie("sid", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // http on localhost/127.0.0.1
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  // No token in the URL — the SPA fetches one via POST /api/refresh.
  res.redirect(FRONTEND_URL);
});

app.post("/api/refresh", async (req, res) => {
  const { sid } = parseCookies(req.headers.cookie);
  const session = sid ? sessions.get(sid) : undefined;
  if (!session) {
    return res.status(401).json({ error: "no_session" });
  }

  try {
    const { accessToken, expiresIn, refreshToken } = await exchangeRefreshToken(
      session.refreshToken,
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    );
    session.refreshToken = refreshToken; // persist Spotify rotation
    res.json({ access_token: accessToken, expires_in: expiresIn });
  } catch (err) {
    console.error("Refresh failed:", err.message);
    sessions.delete(sid);
    res.status(401).json({ error: "refresh_failed" });
  }
});

app.listen(3000, "127.0.0.1", () => {
  console.log("OAuth server listening on http://127.0.0.1:3000");
});
```

- [ ] **Step 2: Verify the server boots and lints**

Run: `npx biome check server/index.js && node --check server/index.js`
Expected: no Biome errors; `node --check` prints nothing (syntax OK).

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm test`
Expected: all tests PASS (Task 1 + existing suite).

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit   # Why/How/Tests: server holds refresh token in a session, sets httpOnly cookie, vends access tokens via /api/refresh
```

---

### Task 3: Vite dev proxy + host

Make the SPA's `/api/refresh` call same-origin (so the cookie is sent) and serve the frontend on `127.0.0.1`.

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Add the `server` block to `vite.config.js`**

Insert a `server` key into the `defineConfig` object (as a sibling of `plugins` and `test`):

```js
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
```

The file becomes:

```js
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/geo.js", "src/spotify.js"],
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 100,
      },
    },
  },
});
```

- [ ] **Step 2: Verify config parses and lints**

Run: `npx biome check vite.config.js && node --check vite.config.js`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add vite.config.js
git commit   # Why/How/Tests: proxy /api to the OAuth server so the session cookie is same-origin in dev
```

---

### Task 4: Client poll-error classifier (`src/pollError.js`)

Extract `MapView`'s error branching into a pure, testable function.

**Files:**
- Create: `src/pollError.js`
- Test: `src/__tests__/pollError.test.js`
- Modify: `vite.config.js` (coverage include)

**Interfaces:**
- Produces: `classifyPollError(message: string): { type: "refresh" } | { type: "retry", seconds: number } | { type: "error" }`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/pollError.test.js`:

```js
import { describe, expect, it } from "vitest";
import { classifyPollError } from "../pollError.js";

describe("classifyPollError", () => {
  it("maps TOKEN_EXPIRED to a refresh action", () => {
    expect(classifyPollError("TOKEN_EXPIRED")).toEqual({ type: "refresh" });
  });

  it("maps RATE_LIMITED to a retry action with seconds", () => {
    expect(classifyPollError("RATE_LIMITED:10")).toEqual({
      type: "retry",
      seconds: 10,
    });
  });

  it("maps anything else to an error action", () => {
    expect(classifyPollError("SPOTIFY_ERROR:503")).toEqual({ type: "error" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/pollError.test.js`
Expected: FAIL — cannot resolve `../pollError.js`.

- [ ] **Step 3: Write the implementation**

Create `src/pollError.js`:

```js
export function classifyPollError(message) {
  if (message === "TOKEN_EXPIRED") return { type: "refresh" };
  if (message.startsWith("RATE_LIMITED:")) {
    return { type: "retry", seconds: Number.parseInt(message.split(":")[1], 10) };
  }
  return { type: "error" };
}
```

- [ ] **Step 4: Add the file to coverage `include`**

In `vite.config.js`, change the coverage `include` line to:

```js
      include: ["src/geo.js", "src/spotify.js", "src/pollError.js"],
```

- [ ] **Step 5: Run the tests to verify they pass with coverage**

Run: `npx vitest run src/__tests__/pollError.test.js --coverage`
Expected: PASS (3 tests); `src/pollError.js` shows 100% functions.

- [ ] **Step 6: Commit**

```bash
git add src/pollError.js src/__tests__/pollError.test.js vite.config.js
git commit   # Why/How/Tests: pure classifier for poll errors so MapView's catch is testable
```

---

### Task 5: Client refresh helper (`src/auth.js`)

The browser-side call that asks the server for a fresh access token.

**Files:**
- Create: `src/auth.js`
- Test: `src/__tests__/auth.test.js`
- Modify: `vite.config.js` (coverage include)

**Interfaces:**
- Produces: `refreshAccessToken(): Promise<string>` — resolves the access token on 200; throws `Error("SESSION_EXPIRED")` on a non-OK response.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/auth.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshAccessToken } from "../auth.js";

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the access token on HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh-token", expires_in: 3600 }),
      }),
    );
    expect(await refreshAccessToken()).toBe("fresh-token");
  });

  it("throws SESSION_EXPIRED on HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(refreshAccessToken()).rejects.toThrow("SESSION_EXPIRED");
  });

  it("sends credentials so the session cookie is included", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await refreshAccessToken();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/auth.test.js`
Expected: FAIL — cannot resolve `../auth.js`.

- [ ] **Step 3: Write the implementation**

Create `src/auth.js`:

```js
export async function refreshAccessToken() {
  const response = await fetch("/api/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error("SESSION_EXPIRED");
  const data = await response.json();
  return data.access_token;
}
```

- [ ] **Step 4: Add the file to coverage `include`**

In `vite.config.js`, change the coverage `include` line to:

```js
      include: ["src/geo.js", "src/spotify.js", "src/pollError.js", "src/auth.js"],
```

- [ ] **Step 5: Run the tests to verify they pass with coverage**

Run: `npx vitest run src/__tests__/auth.test.js --coverage`
Expected: PASS (3 tests); `src/auth.js` shows 100% functions.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js src/__tests__/auth.test.js vite.config.js
git commit   # Why/How/Tests: browser refresh helper that fetches a new access token via the cookie session
```

---

### Task 6: Wire the client (`App.jsx`, `MapView.jsx`)

Bootstrap the token from the server on load, recover from a 401 by refreshing, and add the debug log. Thin glue (not in coverage scope); verified by the full suite still passing and Biome.

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/components/MapView.jsx`

**Interfaces:**
- Consumes: `refreshAccessToken` (Task 5), `classifyPollError` (Task 4).
- `MapView` prop changes from `onSessionExpired` to `onTokenExpired: () => Promise<void>`.

- [ ] **Step 1: Replace `src/App.jsx`**

```jsx
import { useCallback, useEffect, useState } from "react";
import { refreshAccessToken } from "./auth.js";
import LoginButton from "./components/LoginButton.jsx";
import MapView from "./components/MapView.jsx";

export default function App() {
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);
  const [booting, setBooting] = useState(true);

  // Surface an OAuth ?error from the callback redirect, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const e = params.get("error");
    if (e) {
      setError(e);
      window.history.replaceState({}, "", "/");
    }
  }, []);

  // Bootstrap: exchange the session cookie for an access token.
  useEffect(() => {
    let cancelled = false;
    refreshAccessToken()
      .then((t) => {
        if (!cancelled) setToken(t);
      })
      .catch(() => {
        // No valid session — fall through to the login screen.
      })
      .finally(() => {
        if (!cancelled) setBooting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A poll hit a 401: try to refresh; only truly log out if that fails.
  const handleTokenExpired = useCallback(async () => {
    try {
      const t = await refreshAccessToken();
      setToken(t);
    } catch {
      setToken(null);
      setError("session_expired");
    }
  }, []);

  if (booting) return null;

  if (token) {
    return <MapView token={token} onTokenExpired={handleTokenExpired} />;
  }

  return <LoginButton error={error} />;
}
```

- [ ] **Step 2: Update `src/components/MapView.jsx`**

Change the signature and the `catch` block. Replace the top imports and the component so it uses `classifyPollError`, the new prop, and the debug log. The full updated file:

```jsx
import { useEffect, useRef, useState } from "react";
import { lookupArtistLocation } from "../geo.js";
import { classifyPollError } from "../pollError.js";
import { fetchCurrentlyPlaying } from "../spotify.js";
import LeafletMap from "./LeafletMap.jsx";

const POLL_MS = 3_000;
const PACIFIC_FALLBACK = { lat: 0, lng: -160, placeName: "Unknown location" };

export default function MapView({ token, onTokenExpired }) {
  const [track, setTrack] = useState(null);
  const [location, setLocation] = useState(null);
  const [status, setStatus] = useState("loading");
  const lastArtistRef = useRef(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        if (import.meta.env.DEV) {
          // Debug: confirms whether empty-token requests occur (logout hypothesis).
          console.debug("[poll] token present:", Boolean(token));
        }
        const current = await fetchCurrentlyPlaying(token);
        if (cancelled) return;

        if (!current) {
          setStatus("idle");
          return;
        }

        // update track immediately; location catches up asynchronously
        setTrack(current);
        setStatus("playing");

        if (current.artistName !== lastArtistRef.current) {
          lastArtistRef.current = current.artistName;
          const loc = await lookupArtistLocation(current.artistName);
          if (!cancelled) setLocation(loc ?? PACIFIC_FALLBACK);
        }
      } catch (err) {
        if (cancelled) return;
        const action = classifyPollError(err.message);
        if (action.type === "refresh") {
          // Guard: one refresh in flight, even if overlapping polls all 401.
          if (refreshingRef.current) return;
          refreshingRef.current = true;
          try {
            await onTokenExpired();
          } finally {
            refreshingRef.current = false;
          }
          return;
        }
        if (action.type === "retry") {
          // safe to schedule even near unmount: poll() checks cancelled at the top
          setTimeout(poll, action.seconds * 1000);
          return;
        }
        console.error("Poll error:", err);
        setStatus("error");
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, onTokenExpired]);

  if (status === "idle") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontFamily: "sans-serif",
        }}
      >
        <p>Play something on Spotify</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          fontFamily: "sans-serif",
        }}
      >
        <p>Something went wrong. Check the console.</p>
      </div>
    );
  }

  // renders for 'loading' (initial) and 'playing' — LeafletMap handles null track/location
  return <LeafletMap track={track} location={location} />;
}
```

- [ ] **Step 3: Run the full suite and lint**

Run: `npx biome check . && npm test`
Expected: no Biome errors; all tests PASS with coverage thresholds met.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx src/components/MapView.jsx
git commit   # Why/How/Tests: bootstrap token from the server, refresh on 401 instead of logging out, add debug log
```

---

### Task 7: End-to-end manual verification

No code; confirm the feature works against real Spotify and capture what the debug log reveals about the original <2-minute logout.

- [ ] **Step 1: Start both processes**

Run: `npm start`

- [ ] **Step 2: Log in and verify**

Open **`http://127.0.0.1:5173`** (must be `127.0.0.1`, not `localhost`). Click login, complete Spotify auth. Confirm:
- After the redirect the URL is clean (no `?token=`).
- A track is playing → its bubble appears on the map.

- [ ] **Step 3: Confirm it survives a token cycle**

Leave music playing. In DevTools → Network, watch `currently-playing` and `api/refresh`. Confirm that when a poll 401s, an `api/refresh` fires and polling resumes **without** returning to the login screen. Note the DevTools Console `[poll] token present:` lines — if any read `false`, that pins the original empty-token trigger.

- [ ] **Step 4: Report findings**

Summarize: does it stay logged in past the previous ~2-minute mark? Did any `[poll] token present: false` appear? If a structural empty-token bug is confirmed, open a follow-up (the refresh path already self-heals it, but the trigger is worth removing).

---

## Self-Review Notes

- **Spec coverage:** in-memory sessions (T2) ✓; `/callback` keeps refresh token + cookie (T2) ✓; `POST /api/refresh` (T2) ✓; `server/auth.js` helpers (T1) ✓; token removed from URL (T2 redirect + T6 bootstrap) ✓; Vite proxy + 127.0.0.1 (T2 `FRONTEND_URL`, T3) ✓; `src/auth.js` (T5) ✓; `src/pollError.js` (T4) ✓; App bootstrap + recover-or-logout (T6) ✓; MapView refresh-on-401 + guard + debug log (T6) ✓; coverage include for new modules (T4, T5) ✓; manual verification (T7) ✓.
- **Type consistency:** `refreshAccessToken()` returns a string in both `src/auth.js` and its consumers (App); `exchangeRefreshToken` returns `{ accessToken, expiresIn, refreshToken }` used verbatim in T2; `classifyPollError` descriptor shape matches T6's `action.type` / `action.seconds` usage; prop renamed `onSessionExpired` → `onTokenExpired` consistently across App (T6) and MapView (T6).
- **No placeholders:** every code step contains complete content.
