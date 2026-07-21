# Logging & Full Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slow polling to 5s, add non-sensitive runtime logging on both tiers, and bring every source file under test/coverage except a documented set.

**Architecture:** Extract the Express app into a `createApp` factory so routes are testable via supertest; add React Testing Library component tests for `App`, `MapView`, `LoginButton`; add dependency-free `console` logging with a hard no-secrets list; switch coverage to include-globs + a documented exclude list with per-scope thresholds (pure modules strict, components realistic).

**Tech Stack:** Express, Vite + React 18, Vitest (jsdom, v8 coverage), `@testing-library/react`, `@testing-library/jest-dom`, `supertest`, Biome.

## Global Constraints

- New dev dependencies allowed **only**: `@testing-library/react` (^16), `@testing-library/jest-dom` (^6), `supertest` (^7). No others. Run `npm ci` after install to confirm peer deps resolve.
- **Never log**: access tokens, refresh tokens, the `sid` cookie value, the client secret, the OAuth `code`, or any raw `Cookie`/`Authorization` header. OK to log: event names, HTTP status codes, active-session count, and track/artist names.
- Frontend verbose logs are gated behind `import.meta.env.DEV`; `warn`/`error` always on. Backend logs always on.
- No tests assert on log output (that is mock-testing); log lines are covered incidentally.
- Tests never make real network calls; mock `fetch` via `vi.stubGlobal`. Silence `console.info`/`console.error` in test files that would otherwise print, so test output stays pristine.
- Poll interval is exactly `5_000` ms.
- Commit messages follow the `~/.git-template.txt` Why/How/Tests template.
- Pre-commit hook `npx biome check . && npm test` must pass; never `--no-verify`. On a Biome error run `npx biome check --write <file>`, re-add, re-commit. (`npm test` is `vitest run` — no coverage — so intermediate commits are not coverage-gated; coverage is verified in Task 6.)

---

### Task 1: Test infrastructure (deps + setup file)

Install the test tooling and wire the jest-dom matchers. No coverage-config change yet (that is Task 6, after every file has tests).

**Files:**
- Modify: `package.json` (devDependencies — via npm)
- Create: `src/test/setup.js`
- Modify: `vite.config.js` (add `test.setupFiles`)

**Interfaces:**
- Produces: a Vitest environment where `@testing-library/react` renders and `@testing-library/jest-dom` matchers (`toBeInTheDocument`) are available.

- [ ] **Step 1: Install the dev dependencies**

Run: `npm install -D @testing-library/react@^16 @testing-library/jest-dom@^6 supertest@^7`
Then: `npm ci`
Expected: install succeeds; `npm ci` completes with no peer-dependency errors.

- [ ] **Step 2: Create the setup file**

Create `src/test/setup.js`:

```js
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Wire setupFiles into vite.config.js**

In `vite.config.js`, add `setupFiles` inside the `test` block (as a sibling of `environment`/`globals`):

```js
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    coverage: {
```

(Leave the `coverage` block unchanged in this task.)

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npx biome check . && npm test`
Expected: no Biome errors; existing 27 tests still pass, output pristine.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/test/setup.js vite.config.js
git commit   # Why/How/Tests: add RTL + jest-dom + supertest tooling and jest-dom setup
```

---

### Task 2: Server `createApp` factory + backend logging + route tests

Extract the Express app into a testable factory, fold in backend logging, and cover the routes with supertest. TDD: write the route tests first (they import `createApp` which does not exist yet).

**Files:**
- Create: `server/app.js`
- Modify: `server/index.js`
- Test: `server/__tests__/app.test.js`

**Interfaces:**
- Consumes: `parseCookies`, `exchangeRefreshToken` from `server/auth.js`.
- Produces: `createApp({ clientId, clientSecret }): { app, sessions }` — `app` is an Express instance with `GET /callback` and `POST /api/refresh`; `sessions` is the in-memory `Map<sessionId, { refreshToken }>`.

- [ ] **Step 1: Write the failing route tests**

Create `server/__tests__/app.test.js`:

```js
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const CREDS = { clientId: "test-id", clientSecret: "test-secret" };

describe("createApp routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("redirects to the frontend with access_denied when the callback errors", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://127.0.0.1:5173?error=access_denied",
    );
  });

  it("stores a session, sets an httpOnly sid cookie, and redirects with no token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const { app, sessions } = createApp(CREDS);
    const res = await request(app).get("/callback?code=auth-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://127.0.0.1:5173");
    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/^sid=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(sessions.size).toBe(1);
  });

  it("returns 401 from /api/refresh when there is no session cookie", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).post("/api/refresh");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns a fresh access token from /api/refresh for a valid session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh-access", expires_in: 3600 }),
      }),
    );
    const { app, sessions } = createApp(CREDS);
    sessions.set("sid-1", { refreshToken: "refresh-abc" });
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", "sid=sid-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ access_token: "fresh-access", expires_in: 3600 });
  });

  it("evicts the session and returns 401 when Spotify rejects the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const { app, sessions } = createApp(CREDS);
    sessions.set("sid-1", { refreshToken: "refresh-abc" });
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", "sid=sid-1");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "refresh_failed" });
    expect(sessions.has("sid-1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/__tests__/app.test.js`
Expected: FAIL — cannot resolve `../app.js`.

- [ ] **Step 3: Create `server/app.js`**

```js
import { randomUUID } from "node:crypto";
import express from "express";
import { exchangeRefreshToken, parseCookies } from "./auth.js";

const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const FRONTEND_URL = "http://127.0.0.1:5173";

export function createApp({ clientId, clientSecret }) {
  const app = express();

  // sessionId -> { refreshToken }. In-memory: a server restart clears sessions
  // (re-login), which is acceptable for local dev. Swap for a real store later.
  const sessions = new Map();

  app.get("/callback", async (req, res) => {
    const { code, error } = req.query;
    console.info("[server] OAuth callback received");

    if (error || !code) {
      return res.redirect(`${FRONTEND_URL}?error=access_denied`);
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
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
      console.error("[server] token exchange network error:", err.message);
      return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
    }

    if (!tokenResponse.ok) {
      console.error("[server] token exchange failed:", tokenResponse.status);
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
      console.error("[server] failed to parse token response:", err.message);
      return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
    }

    const sessionId = randomUUID();
    sessions.set(sessionId, { refreshToken });
    console.info(`[server] session created (${sessions.size} active)`);

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
    console.info("[server] token refresh requested");
    if (!session) {
      return res.status(401).json({ error: "no_session" });
    }

    try {
      const { accessToken, expiresIn, refreshToken } =
        await exchangeRefreshToken(session.refreshToken, {
          clientId,
          clientSecret,
        });
      session.refreshToken = refreshToken; // persist Spotify rotation
      console.info("[server] token refresh succeeded");
      res.json({ access_token: accessToken, expires_in: expiresIn });
    } catch (err) {
      console.error("[server] token refresh failed, session evicted:", err.message);
      sessions.delete(sid);
      res.status(401).json({ error: "refresh_failed" });
    }
  });

  return { app, sessions };
}
```

- [ ] **Step 4: Shrink `server/index.js` to a thin entry point**

Replace the entire contents of `server/index.js`:

```js
import "dotenv/config";
import { createApp } from "./app.js";

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing VITE_SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env",
  );
  process.exit(1);
}

const { app } = createApp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

app.listen(3000, "127.0.0.1", () => {
  console.log("[server] OAuth server listening on http://127.0.0.1:3000");
});
```

- [ ] **Step 5: Run the tests + lint + syntax check**

Run: `npx vitest run server/__tests__/app.test.js`
Expected: PASS (5 tests).
Run: `npx biome check . && node --check server/index.js && node --check server/app.js`
Expected: no errors.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass (existing 27 + 5 new = 32), output pristine.

- [ ] **Step 7: Commit**

```bash
git add server/app.js server/index.js server/__tests__/app.test.js
git commit   # Why/How/Tests: extract createApp factory, add backend logging, cover routes with supertest
```

---

### Task 3: Poll interval 5s + MapView logging + MapView tests

Slow polling, replace the ad-hoc debug log with proper `[poll]` events, and cover the poll loop with RTL.

**Files:**
- Modify: `src/components/MapView.jsx`
- Test: `src/components/__tests__/MapView.test.jsx`

**Interfaces:**
- Consumes: `classifyPollError` (`src/pollError.js`), `fetchCurrentlyPlaying` (`src/spotify.js`), `lookupArtistLocation` (`src/geo.js`), `LeafletMap`.
- Prop contract unchanged: `MapView({ token, onTokenExpired })`.

- [ ] **Step 1: Write the failing MapView tests**

Create `src/components/__tests__/MapView.test.jsx`:

```jsx
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../geo.js", () => ({
  lookupArtistLocation: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../spotify.js", () => ({ fetchCurrentlyPlaying: vi.fn() }));
vi.mock("../LeafletMap.jsx", () => ({
  default: () => <div data-testid="leaflet-map" />,
}));

import { fetchCurrentlyPlaying } from "../../spotify.js";
import MapView from "../MapView.jsx";

describe("MapView poll loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("refreshes (does not log out) when a poll returns 401", async () => {
    fetchCurrentlyPlaying.mockRejectedValue(new Error("TOKEN_EXPIRED"));
    const onTokenExpired = vi.fn().mockResolvedValue(undefined);
    render(<MapView token="t" onTokenExpired={onTokenExpired} />);
    await waitFor(() => expect(onTokenExpired).toHaveBeenCalledTimes(1));
  });

  it("retries after the rate-limit delay", async () => {
    vi.useFakeTimers();
    fetchCurrentlyPlaying.mockRejectedValue(new Error("RATE_LIMITED:2"));
    render(<MapView token="t" onTokenExpired={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(0); // initial poll rejects, schedules retry
    const callsAfterInitial = fetchCurrentlyPlaying.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000); // fire the scheduled retry
    expect(fetchCurrentlyPlaying.mock.calls.length).toBeGreaterThan(
      callsAfterInitial,
    );
    vi.useRealTimers();
  });

  it("guards against concurrent refreshes across overlapping polls", async () => {
    vi.useFakeTimers();
    fetchCurrentlyPlaying.mockRejectedValue(new Error("TOKEN_EXPIRED"));
    let resolveRefresh;
    const onTokenExpired = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    render(<MapView token="t" onTokenExpired={onTokenExpired} />);
    await vi.advanceTimersByTimeAsync(0); // initial poll -> refresh in flight (pending)
    await vi.advanceTimersByTimeAsync(5000); // interval fires a 2nd poll while pending
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    resolveRefresh?.();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/__tests__/MapView.test.jsx`
Expected: FAIL — the retry/guard timing tests fail against `POLL_MS = 3_000` (guard test advances 5000 expecting the interval tick), and the file exercises current behavior. (If the 401 test passes already, that is fine — the retry and guard tests are the ones that must drive the change.)

- [ ] **Step 3: Update `src/components/MapView.jsx`**

Change `POLL_MS` and replace the debug log with `[poll]` info logs. Replace lines 7 and 20-25 and add event logs. The full updated `poll()` region and constant:

```jsx
const POLL_MS = 5_000;
```

Replace the body of `poll()` (the `try` block start and the branches) so it reads:

```jsx
    async function poll() {
      try {
        const current = await fetchCurrentlyPlaying(token);
        if (cancelled) return;

        if (!current) {
          if (import.meta.env.DEV) console.info("[poll] nothing playing");
          setStatus("idle");
          return;
        }

        // update track immediately; location catches up asynchronously
        setTrack(current);
        setStatus("playing");
        if (import.meta.env.DEV) {
          console.info(
            `[poll] now playing: ${current.artistName} – ${current.trackName}`,
          );
        }

        if (current.artistName !== lastArtistRef.current) {
          lastArtistRef.current = current.artistName;
          if (import.meta.env.DEV) {
            console.info(`[poll] artist changed, looking up ${current.artistName}`);
          }
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
          if (import.meta.env.DEV) console.info("[poll] token expired, refreshing");
          try {
            await onTokenExpired();
          } finally {
            refreshingRef.current = false;
          }
          return;
        }
        if (action.type === "retry") {
          if (import.meta.env.DEV) {
            console.info(`[poll] rate limited, retrying in ${action.seconds}s`);
          }
          // safe to schedule even near unmount: poll() checks cancelled at the top
          setTimeout(poll, action.seconds * 1000);
          return;
        }
        console.error("[poll] error:", err.message);
        setStatus("error");
      }
    }
```

(The `import.meta.env.DEV` debug block at the top of the old `poll()` is removed; `PACIFIC_FALLBACK`, the refs, the `setInterval(poll, POLL_MS)` wiring, and the JSX below are unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/MapView.test.jsx`
Expected: PASS (3 tests), output pristine (console silenced).

- [ ] **Step 5: Full suite + lint**

Run: `npx biome check . && npm test`
Expected: no Biome errors; all tests pass (35 total).

- [ ] **Step 6: Commit**

```bash
git add src/components/MapView.jsx src/components/__tests__/MapView.test.jsx
git commit   # Why/How/Tests: 5s poll, [poll] event logging, cover the poll loop with RTL
```

---

### Task 4: App + auth.js logging + App tests

Add client bootstrap/refresh logging and cover `App`'s branching with RTL. `auth.js` gets one log line; its existing test file silences console to stay pristine.

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/auth.js`
- Modify: `src/__tests__/auth.test.js` (add console silencing)
- Test: `src/__tests__/App.test.jsx`

**Interfaces:**
- Consumes: `refreshAccessToken` (`src/auth.js`), child components `MapView`, `LoginButton` (stubbed in the App test).

- [ ] **Step 1: Write the failing App tests**

Create `src/__tests__/App.test.jsx`:

```jsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({ refreshAccessToken: vi.fn() }));
vi.mock("../components/MapView.jsx", () => ({
  default: ({ onTokenExpired }) => (
    <button type="button" data-testid="map" onClick={onTokenExpired}>
      map
    </button>
  ),
}));
vi.mock("../components/LoginButton.jsx", () => ({
  default: ({ error }) => <div data-testid="login">{error ?? "login"}</div>,
}));

import App from "../App.jsx";
import { refreshAccessToken } from "../auth.js";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("shows the map once the session bootstrap returns a token", async () => {
    refreshAccessToken.mockResolvedValue("access-token");
    render(<App />);
    expect(await screen.findByTestId("map")).toBeInTheDocument();
  });

  it("shows the login screen when there is no session", async () => {
    refreshAccessToken.mockRejectedValue(new Error("SESSION_EXPIRED"));
    render(<App />);
    expect(await screen.findByTestId("login")).toBeInTheDocument();
  });

  it("recovers by refreshing when the token expires, staying on the map", async () => {
    refreshAccessToken.mockResolvedValueOnce("token-1"); // bootstrap
    render(<App />);
    const map = await screen.findByTestId("map");
    refreshAccessToken.mockResolvedValueOnce("token-2"); // the refresh
    fireEvent.click(map);
    await waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("map")).toBeInTheDocument();
  });

  it("logs out when the refresh during token expiry fails", async () => {
    refreshAccessToken.mockResolvedValueOnce("token-1"); // bootstrap
    render(<App />);
    const map = await screen.findByTestId("map");
    refreshAccessToken.mockRejectedValueOnce(new Error("SESSION_EXPIRED"));
    fireEvent.click(map);
    expect(await screen.findByTestId("login")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/App.test.jsx`
Expected: FAIL — assertions run against current `App` with no logging; tests should pass on behavior but this step confirms the file loads and the harness is wired. If all four pass immediately, proceed (App behavior already satisfies them); the logging additions in Step 3 must not break them.

- [ ] **Step 3: Add logging to `src/App.jsx`**

Insert DEV-gated info logs. Change the two effect callbacks and `handleTokenExpired`:

```jsx
  // Bootstrap: exchange the session cookie for an access token.
  useEffect(() => {
    let cancelled = false;
    if (import.meta.env.DEV) console.info("[app] bootstrapping session");
    refreshAccessToken()
      .then((t) => {
        if (cancelled) return;
        if (import.meta.env.DEV) console.info("[app] session restored");
        setToken(t);
      })
      .catch(() => {
        if (import.meta.env.DEV) console.info("[app] no active session, showing login");
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
    if (import.meta.env.DEV) console.info("[app] token expired, refreshing");
    try {
      const t = await refreshAccessToken();
      if (import.meta.env.DEV) console.info("[app] token refreshed");
      setToken(t);
    } catch {
      if (import.meta.env.DEV) console.info("[app] refresh failed, logging out");
      setToken(null);
      setError("session_expired");
    }
  }, []);
```

- [ ] **Step 4: Add one log line to `src/auth.js`**

Change `refreshAccessToken` so it logs before the request (no token value):

```js
export async function refreshAccessToken() {
  if (import.meta.env.DEV) console.info("[app] requesting token refresh");
  const response = await fetch("/api/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) throw new Error("SESSION_EXPIRED");
  const data = await response.json();
  return data.access_token;
}
```

- [ ] **Step 5: Silence console in the existing auth test**

In `src/__tests__/auth.test.js`, add a console spy so the new log line does not print. In the `beforeEach` of the `refreshAccessToken` describe block, add after `vi.restoreAllMocks();`:

```js
    vi.spyOn(console, "info").mockImplementation(() => {});
```

- [ ] **Step 6: Run tests + lint**

Run: `npx vitest run src/__tests__/App.test.jsx src/__tests__/auth.test.js`
Expected: PASS, output pristine.
Run: `npx biome check . && npm test`
Expected: no Biome errors; all tests pass (39 total).

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/auth.js src/__tests__/auth.test.js src/__tests__/App.test.jsx
git commit   # Why/How/Tests: client bootstrap/refresh logging, cover App branching with RTL
```

---

### Task 5: LoginButton tests

Cover the presentational component. No source change — it is already testable.

**Files:**
- Test: `src/components/__tests__/LoginButton.test.jsx`

- [ ] **Step 1: Write the tests**

Create `src/components/__tests__/LoginButton.test.jsx`:

```jsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LoginButton from "../LoginButton.jsx";

describe("LoginButton", () => {
  it("renders a Spotify login link", () => {
    render(<LoginButton error={null} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("accounts.spotify.com/authorize"),
    );
    expect(
      screen.getByRole("button", { name: /login with spotify/i }),
    ).toBeInTheDocument();
  });

  it("shows the session-expired message when that error is set", () => {
    render(<LoginButton error="session_expired" />);
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("shows the access-denied message when that error is set", () => {
    render(<LoginButton error="access_denied" />);
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/LoginButton.test.jsx`
Expected: PASS (3 tests). (`buildAuthUrl` reads `VITE_SPOTIFY_CLIENT_ID=test-client-id` from `.env.test`, already present.)

- [ ] **Step 3: Full suite + lint**

Run: `npx biome check . && npm test`
Expected: no errors; all tests pass (42 total).

- [ ] **Step 4: Commit**

```bash
git add src/components/__tests__/LoginButton.test.jsx
git commit   # Why/How/Tests: cover LoginButton rendering + error messages
```

---

### Task 6: Coverage config — globs, documented excludes, scoped thresholds

Now every non-excluded file has tests. Switch coverage to include-globs + a documented exclude list, with strict per-file thresholds on the pure modules and a realistic global floor.

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Replace the `coverage` block in `vite.config.js`**

Replace the existing `coverage: { ... }` object inside `test` with:

```js
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.{js,jsx}", "server/**/*.js"],
      exclude: [
        "**/__tests__/**",
        "**/*.test.{js,jsx}",
        "src/test/setup.js",
        "src/main.jsx", // React DOM entry point (createRoot+render); no logic to test
        "server/index.js", // process entry point (env check + listen); logic lives in server/app.js
        "src/components/LeafletMap.jsx", // react-leaflet wrapper; needs real canvas/map sizing jsdom lacks
        "src/components/AlbumBubble.jsx", // builds a Leaflet divIcon; same canvas/DOM constraint
      ],
      thresholds: {
        // Global floor across every included file (components + app.js keep this realistic).
        statements: 80,
        branches: 70,
        functions: 85,
        // Pure-logic modules held to the strict bar, each file individually.
        "src/geo.js": { statements: 90, branches: 75, functions: 100, perFile: true },
        "src/spotify.js": { statements: 90, branches: 75, functions: 100, perFile: true },
        "src/pollError.js": { statements: 90, branches: 75, functions: 100, perFile: true },
        "src/auth.js": { statements: 90, branches: 75, functions: 100, perFile: true },
        "server/auth.js": { statements: 90, branches: 75, functions: 100, perFile: true },
      },
    },
```

- [ ] **Step 2: Run coverage and verify all thresholds pass**

Run: `npx vitest run --coverage`
Expected: all tests pass AND no threshold errors. The text report lists `src/App.jsx`, `src/components/MapView.jsx`, `src/components/LoginButton.jsx`, `server/app.js`, and the five strict pure modules; excluded files do not appear.

If a strict pure module is below 100% functions, that is a real gap — add the missing test before continuing. If the global floor (80/70/85) is not met by a component, either the component test is too thin (strengthen it) or, only if the miss is inherent to untestable glue, lower that specific global number by the smallest amount and note why in the commit. Do not lower a `perFile` pure-module threshold.

- [ ] **Step 3: Confirm no secrets are logged**

Run: `grep -rnE "console\.(log|info|warn|error|debug)" src server | grep -iE "token|secret|refreshtoken|access_token|\\bsid\\b|cookie|authorization|\\bcode\\b" || echo "OK: no sensitive identifiers in log calls"`
Expected: `OK: no sensitive identifiers in log calls` (the session-count log says "session created (N active)", never the sid; the refresh logs name events, never tokens).

- [ ] **Step 4: Lint + full suite**

Run: `npx biome check . && npm test`
Expected: no errors; all 42 tests pass.

- [ ] **Step 5: Commit**

```bash
git add vite.config.js
git commit   # Why/How/Tests: coverage via include-globs + documented excludes + scoped thresholds
```

---

### Task 7: Manual sanity check (human-run)

No code. Confirm the logs read clearly and expose nothing sensitive against the running app.

- [ ] **Step 1:** `npm start`, open `http://127.0.0.1:5173`, log in, play a track.
- [ ] **Step 2:** Watch the **browser console** — confirm `[app]` and `[poll]` lines narrate bootstrap → now-playing → (on expiry) refresh, and that **no token/cookie value** appears.
- [ ] **Step 3:** Watch the **server terminal** — confirm `[server]` lines narrate callback → session created (N active) → refresh requested/succeeded, with **no sid or token** printed.
- [ ] **Step 4:** Confirm polling now happens every ~5s (space between `[poll]` lines).

---

## Self-Review Notes

- **Spec coverage:** poll 5s (T3) ✓; backend logging (T2) ✓; frontend logging App/MapView/auth (T3,T4) ✓; no-secrets rule (constraints + T6 grep) ✓; DEV-gated verbose logs (T3,T4) ✓; new dev deps + setup (T1) ✓; server createApp refactor (T2) ✓; supertest route tests (T2) ✓; App/MapView/LoginButton RTL tests (T3,T4,T5) ✓; coverage globs + documented excludes + reasons (T6) ✓; scoped thresholds strict-pure/realistic-components (T6) ✓; manual sanity (T7) ✓.
- **Type consistency:** `createApp({ clientId, clientSecret })` → `{ app, sessions }` used identically in `server/index.js` (T2) and `server/__tests__/app.test.js` (T2); `sessions` is a `Map` seeded with `{ refreshToken }` in tests, matching `server/app.js`; `MapView` prop `onTokenExpired` unchanged; `refreshAccessToken()` returns a token string in App/auth (T4).
- **No placeholders:** every code step is complete; the one conditional in T6 Step 2 (how to react if a threshold misses) is guidance for a verification outcome, not an unwritten implementation.
