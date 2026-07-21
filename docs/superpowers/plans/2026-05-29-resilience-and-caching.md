# Resilience & Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop hammering the public MusicBrainz/Nominatim APIs by caching artist→location lookups, fix the muddled polling loop so rate-limiting actually backs off, and cover the polling state machine with tests (it's the app's trickiest code and currently has none).

**Architecture:** Three independent, local changes. (1) Wrap `lookupArtistLocation` with an in-memory cache keyed by artist name that also memoizes *negative* results, so an unknown artist isn't re-queried on every poll. (2) Replace `MapView`'s `setInterval` + ad-hoc `setTimeout` (which adds extra polls under rate-limiting instead of slowing down) with a single self-scheduling `setTimeout` loop whose delay depends on the outcome. (3) Add `MapView` tests using `@testing-library/react` with fake timers, mocking the two service modules so no Leaflet/network is involved.

**Tech Stack:** Vanilla JS (Map-based cache), React 18, Vitest fake timers, `@testing-library/react`.

> **The AWS Lambda/Terraform migration is deliberately NOT in this plan.** See "Out of Scope" at the end — it needs a brainstorming session first because it depends on decisions only the author can make. This plan delivers the *local* resilience work that the rate limits actually justify today.

---

## Why these changes (for the author)

- **Caching:** MusicBrainz and Nominatim both enforce ~1 request/second and explicitly forbid heavy automated use. The app currently fires two calls on every artist change with zero caching — replay the same artist and it queries again. A cache (including remembering "we already know this artist has no location") is the single highest-value reliability fix, and it's the natural seam where a real persistent cache (DynamoDB/Redis) would later slot in.
- **Polling refactor:** Today `poll()` runs on a fixed `setInterval(3s)`, and on HTTP 429 it *also* schedules an extra `setTimeout(poll)`. The interval never slows down, so under rate-limiting you poll *more*, not less. A self-scheduling loop (run, then schedule the next run based on what just happened) is the idiomatic fix and makes back-off correct.
- **Tests:** the polling/cancel/rate-limit/token-expiry logic is where a regression will actually break the app, yet it has no tests. The "96% coverage" only reflects the pure modules.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/location-cache.js` | `createLocationCache(lookupFn)` → cached lookup (memoizes hits *and* misses) | Create |
| `src/geo.js` | Export a cached `lookupArtistLocation` wrapping the raw fetch logic | Modify |
| `src/components/MapView.jsx` | Self-scheduling poll loop with outcome-based delay | Modify |
| `src/__tests__/location-cache.test.js` | Cache hit/miss/negative-caching behavior | Create |
| `src/__tests__/MapView.test.jsx` | Polling state machine | Create |
| `vite.config.js` | Add `MapView.jsx` + `location-cache.js` to coverage include | Modify |

---

### Task 1: In-memory location cache (pure, generic)

Build the cache as a generic wrapper around any async lookup function so it's trivial to test without touching the network.

**Files:**
- Create: `src/location-cache.js`, `src/__tests__/location-cache.test.js`

- [ ] **Step 1: Write the failing test `src/__tests__/location-cache.test.js`**

```js
import { describe, expect, it, vi } from "vitest";
import { createLocationCache } from "../location-cache.js";

describe("createLocationCache", () => {
  it("calls the underlying lookup once per distinct key", async () => {
    const lookup = vi.fn().mockResolvedValue({ lat: 1, lng: 2, placeName: "X" });
    const cached = createLocationCache(lookup);

    await cached("Radiohead");
    await cached("Radiohead");

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("Radiohead");
  });

  it("returns the cached value on the second call", async () => {
    const lookup = vi.fn().mockResolvedValue({ lat: 1, lng: 2, placeName: "X" });
    const cached = createLocationCache(lookup);

    const first = await cached("Radiohead");
    const second = await cached("Radiohead");

    expect(second).toEqual(first);
  });

  it("caches negative (null) results so unknown artists are not re-queried", async () => {
    const lookup = vi.fn().mockResolvedValue(null);
    const cached = createLocationCache(lookup);

    expect(await cached("Nobody")).toBeNull();
    expect(await cached("Nobody")).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejected lookup (so a transient error can be retried)", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ lat: 1, lng: 2, placeName: "X" });
    const cached = createLocationCache(lookup);

    await expect(cached("Flaky")).rejects.toThrow("boom");
    await expect(cached("Flaky")).resolves.toEqual({ lat: 1, lng: 2, placeName: "X" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("treats keys case-insensitively after trimming", async () => {
    const lookup = vi.fn().mockResolvedValue({ lat: 1, lng: 2, placeName: "X" });
    const cached = createLocationCache(lookup);

    await cached("Radiohead");
    await cached("  radiohead ");

    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/location-cache.test.js`
Expected: FAIL with "Failed to resolve import ../location-cache.js".

- [ ] **Step 3: Create `src/location-cache.js`**

```js
// Wraps an async (name -> location|null) lookup with an in-memory cache.
// Caches both hits and misses (null) so unknown artists are queried only once.
// Does NOT cache rejections, so a transient network error can be retried.
export function createLocationCache(lookupFn) {
  const cache = new Map();

  return async function cachedLookup(artistName) {
    const key = String(artistName ?? "").trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);

    const result = await lookupFn(artistName);
    cache.set(key, result);
    return result;
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/location-cache.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/location-cache.js src/__tests__/location-cache.test.js
git commit -m "feat: in-memory location cache with negative caching

Why: avoid re-querying MusicBrainz/Nominatim for repeat (and unknown) artists.
How: createLocationCache memoizes hits and misses by normalized name; does not
cache rejections so transient errors can be retried.
Tests: src/__tests__/location-cache.test.js (5 cases)."
```

---

### Task 2: Apply the cache to `lookupArtistLocation`

Rename the raw network function and export a cached wrapper under the existing name so `MapView` and the existing `geo.test.js` keep working unchanged.

**Files:**
- Modify: `src/geo.js`

- [ ] **Step 1: Wrap the existing function**

In `src/geo.js`, rename the current `export async function lookupArtistLocation(artistName) {` to `async function lookupArtistLocationUncached(artistName) {` (keep its entire body). Then add the import at the top and the cached export at the bottom:

At the top, after the existing constants:

```js
import { createLocationCache } from "./location-cache.js";
```

At the bottom of the file:

```js
export const lookupArtistLocation = createLocationCache(lookupArtistLocationUncached);
```

- [ ] **Step 2: Run the existing geo tests (they must still pass)**

Run: `npx vitest run src/__tests__/geo.test.js`
Expected: PASS — but note the tests reuse the same artist names. Because the cache is module-level and persists across tests in a file, distinct names per test are required.

Check `src/__tests__/geo.test.js`: the cases use `"Unknown Artist XYZ"`, `"Test"`, `"Kendrick Lamar"`, and `"Test Artist"`. Two cases reuse `"Test"` and two reuse `"Test Artist"`, which the cache would collapse. If any case fails because the mock wasn't called, fix it by giving each test a unique artist name (e.g. `"Test One"`, `"Test Two"`).

- [ ] **Step 3: If needed, make artist names unique per test**

If Step 2 shows failures, edit `src/__tests__/geo.test.js` so each `it(...)` uses a distinct artist string. Re-run:

Run: `npx vitest run src/__tests__/geo.test.js`
Expected: PASS.

- [ ] **Step 4: Run Biome**

Run: `npx biome check .`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/geo.js src/__tests__/geo.test.js
git commit -m "feat: cache artist location lookups

Why: cut repeat calls to rate-limited MusicBrainz/Nominatim.
How: kept the raw lookup as lookupArtistLocationUncached and exported a cached
wrapper under the original name; deduped artist names in geo.test.js.
Tests: src/__tests__/geo.test.js still green."
```

---

### Task 3: Self-scheduling poll loop with correct back-off

Replace the `setInterval` + extra-`setTimeout` pattern with a single recursive `setTimeout` whose next delay is chosen by the outcome. This fixes the bug where rate-limiting added polls instead of slowing them.

**Files:**
- Modify: `src/components/MapView.jsx`

- [ ] **Step 1: Replace the polling `useEffect`**

In `src/components/MapView.jsx`, replace the entire effect (the `useEffect(() => { ... }, [token, onSessionExpired])` block, including `POLL_MS`) with:

```jsx
const POLL_MS = 3_000;

// ...inside the component:

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    function schedule(delayMs) {
      if (cancelled) return;
      timer = setTimeout(run, delayMs);
    }

    async function run() {
      if (cancelled) return;
      try {
        const current = await fetchCurrentlyPlaying(token);
        if (cancelled) return;

        if (!current) {
          setStatus("idle");
          return schedule(POLL_MS);
        }

        setTrack(current);
        setStatus("playing");

        if (current.artistName !== lastArtistRef.current) {
          lastArtistRef.current = current.artistName;
          const loc = await lookupArtistLocation(current.artistName);
          if (!cancelled) setLocation(loc ?? PACIFIC_FALLBACK);
        }
        return schedule(POLL_MS);
      } catch (err) {
        if (cancelled) return;
        if (err.message === "TOKEN_EXPIRED") {
          onSessionExpired();
          return; // stop the loop; session is over
        }
        if (err.message.startsWith("RATE_LIMITED:")) {
          const seconds = Number.parseInt(err.message.split(":")[1], 10) || 5;
          return schedule(seconds * 1000); // back off, don't pile on
        }
        console.error("Poll error:", err);
        setStatus("error");
        return schedule(POLL_MS); // keep trying after transient errors
      }
    }

    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, onSessionExpired]);
```

Keep the existing `PACIFIC_FALLBACK` constant and the `useState`/`useRef` declarations as they are.

- [ ] **Step 2: Verify the build + existing suite**

Run: `npm test && npm run build`
Expected: build succeeds; existing tests still pass (MapView has no test yet — added next task).

- [ ] **Step 3: Commit**

```bash
git add src/components/MapView.jsx
git commit -m "fix: self-scheduling poll loop with real rate-limit backoff

Why: the old setInterval + extra setTimeout added polls under HTTP 429 instead
of slowing down.
How: single recursive setTimeout; next delay chosen by outcome (normal, 429
backoff, stop on token expiry).
Tests: existing suite green; MapView tests added in the next task."
```

---

### Task 4: MapView polling state-machine tests

Mock both service modules and the `LeafletMap` child (so no Leaflet/DOM-size machinery runs), drive the loop with fake timers, and assert each branch.

**Files:**
- Create: `src/__tests__/MapView.test.jsx`
- Prerequisite: `@testing-library/react` (install if Plan 1 hasn't already)

- [ ] **Step 1: Ensure `@testing-library/react` is installed**

Run: `npm ls @testing-library/react`
If absent: `npm install -D @testing-library/react@^16`

- [ ] **Step 2: Write the failing test `src/__tests__/MapView.test.jsx`**

```jsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the children/services so no Leaflet or network runs.
vi.mock("../spotify.js", () => ({ fetchCurrentlyPlaying: vi.fn() }));
vi.mock("../geo.js", () => ({ lookupArtistLocation: vi.fn() }));
vi.mock("../components/LeafletMap.jsx", () => ({
  default: ({ track }) => <div data-testid="map">{track ? track.trackName : "no-track"}</div>,
}));

import { lookupArtistLocation } from "../geo.js";
import { fetchCurrentlyPlaying } from "../spotify.js";
import MapView from "../components/MapView.jsx";

const TRACK = { trackName: "HUMBLE.", artistName: "Kendrick Lamar", albumImageUrl: "u" };

describe("MapView polling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the idle overlay when nothing is playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(null);
    render(<MapView token="t" onSessionExpired={() => {}} onLogout={() => {}} />);
    await vi.waitFor(() => expect(screen.getByText(/play something on spotify/i)).toBeTruthy());
  });

  it("looks up the artist location once when a track is playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(TRACK);
    lookupArtistLocation.mockResolvedValue({ lat: 1, lng: 2, placeName: "Compton" });
    render(<MapView token="t" onSessionExpired={() => {}} onLogout={() => {}} />);
    await vi.waitFor(() => expect(lookupArtistLocation).toHaveBeenCalledWith("Kendrick Lamar"));
    expect(lookupArtistLocation).toHaveBeenCalledTimes(1);
  });

  it("calls onSessionExpired and stops polling on TOKEN_EXPIRED", async () => {
    fetchCurrentlyPlaying.mockRejectedValue(new Error("TOKEN_EXPIRED"));
    const onSessionExpired = vi.fn();
    render(<MapView token="t" onSessionExpired={onSessionExpired} onLogout={() => {}} />);
    await vi.waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));

    // Advance well past a normal poll interval; no further polls should fire.
    fetchCurrentlyPlaying.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchCurrentlyPlaying).not.toHaveBeenCalled();
  });

  it("backs off by the Retry-After seconds on RATE_LIMITED", async () => {
    fetchCurrentlyPlaying
      .mockRejectedValueOnce(new Error("RATE_LIMITED:30"))
      .mockResolvedValue(null);
    render(<MapView token="t" onSessionExpired={() => {}} onLogout={() => {}} />);

    // After the first (rejected) call, nothing should re-poll before 30s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchCurrentlyPlaying).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(27_000);
    expect(fetchCurrentlyPlaying).toHaveBeenCalledTimes(2);
  });

  it("does not re-look-up location when the same artist keeps playing", async () => {
    fetchCurrentlyPlaying.mockResolvedValue(TRACK);
    lookupArtistLocation.mockResolvedValue({ lat: 1, lng: 2, placeName: "Compton" });
    render(<MapView token="t" onSessionExpired={() => {}} onLogout={() => {}} />);

    await vi.waitFor(() => expect(lookupArtistLocation).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(6_000); // two more poll cycles, same artist
    expect(lookupArtistLocation).toHaveBeenCalledTimes(1);
  });
});
```

> **Note:** this test assumes `MapView` accepts `onLogout` (added by the design-adoption plan). If that plan hasn't run, `MapView`'s signature is `({ token, onSessionExpired })` — drop the `onLogout` prop from these renders. The polling behavior under test is identical either way.

- [ ] **Step 3: Run the test to verify it fails (then passes)**

Run: `npx vitest run src/__tests__/MapView.test.jsx`
Expected: with Task 3's loop in place, these PASS (5 tests). If you run this task *before* Task 3, the RATE_LIMITED back-off test fails (old code keeps the 3s interval running) — which is exactly the bug Task 3 fixes.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/MapView.test.jsx
git commit -m "test: cover MapView polling state machine

Why: the polling/backoff/expiry logic had no tests despite being the app's
trickiest code.
How: mocked spotify/geo/LeafletMap, drove the loop with fake timers, asserted
idle, lookup-once, token-expiry stop, 429 backoff, and same-artist dedupe.
Tests: src/__tests__/MapView.test.jsx (5 cases)."
```

---

### Task 5: Coverage config

**Files:**
- Modify: `vite.config.js`

- [ ] **Step 1: Add the new files to `coverage.include`**

Change `coverage.include` from:

```js
      include: ["src/geo.js", "src/spotify.js"],
```
to:

```js
      include: ["src/geo.js", "src/spotify.js", "src/location-cache.js", "src/components/MapView.jsx"],
```

- [ ] **Step 2: Verify coverage thresholds still pass**

Run: `npx vitest run --coverage`
Expected: PASS; the new files appear in the coverage table. If `MapView.jsx` dips below the branch threshold (75%), that's acceptable signal — but the 5 tests should cover the main branches. Do not lower thresholds to pass; add a test case if a real branch is uncovered.

- [ ] **Step 3: Commit**

```bash
git add vite.config.js
git commit -m "chore: measure coverage for cache and MapView

Why: keep coverage meaningful now that the polling logic is tested.
How: added src/location-cache.js and src/components/MapView.jsx to the include.
Tests: npx vitest run --coverage passes thresholds."
```

---

## Out of Scope — needs its own plan (and a brainstorm first)

The critique's third move ended with "…then do the Lambda + Terraform migration as your first real AWS slice." That migration is intentionally **not** planned here, because a good TDD plan can't be written without decisions only you can make. Writing exact Terraform/Lambda code now would mean inventing those answers. Open questions for a `superpowers:brainstorming` session:

1. **AWS account + region** — which account, which region, and is there an existing IaC convention to follow?
2. **IaC tool** — Terraform (matches your stated learning goal) vs AWS CDK vs SAM. Terraform is the likely pick; confirm.
3. **What migrates first** — the cleanest first slice is moving `server/index.js` (the stateless OAuth callback + `/login`) to **API Gateway + Lambda**. The `state` cookie and token-exchange logic port directly. Does local `npm start` still need to work (i.e., keep the Express server for dev, deploy the Lambda for "prod")?
4. **The cache's persistent home** — `src/location-cache.js` (Task 1) is the seam where a **DynamoDB** table would slot in. But the cache currently lives in the *browser*; a shared/persistent cache implies a server-side lookup endpoint. That's a small architecture shift (browser → your API → MusicBrainz/Nominatim) worth deciding deliberately.
5. **Secrets** — `SPOTIFY_CLIENT_SECRET` would move from `.env` to AWS Secrets Manager / SSM Parameter Store.

**Recommended sequence:** finish this plan (local resilience) → brainstorm the AWS slice → write `docs/superpowers/plans/<date>-aws-oauth-lambda.md` for just the API Gateway + Lambda + Terraform piece → then a separate plan for the DynamoDB-backed shared cache if you still want it.

---

## Self-Review

- **Spec coverage:** caching with negative caching (T1), applied to `lookupArtistLocation` (T2), polling back-off fix (T3), MapView state-machine tests (T4), coverage config (T5). AWS migration explicitly deferred with the decisions it depends on (Out of Scope). ✅
- **Placeholders:** none — full code for the cache, the geo wrapping instructions, the rewritten poll loop, and all 5 MapView tests. ✅
- **Type consistency:** `createLocationCache(lookupFn)` signature identical in test (T1) and call site (T2); cached export named `lookupArtistLocation` so `MapView` import is unchanged; `PACIFIC_FALLBACK` and `lastArtistRef` reused as-is in T3; `MapView` prop note (T4) reconciles with/without the design-adoption plan's `onLogout`. ✅
- **Ordering caveat documented:** T4's 429 test only passes after T3 (called out in T4 Step 3). ✅
