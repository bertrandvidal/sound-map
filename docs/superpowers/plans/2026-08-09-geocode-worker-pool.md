# Geocode Resolution Worker Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the strictly sequential artist-resolution loop in `src/useLibraryArtists.js` with a bounded worker pool, so that time spent waiting on the server-side throttle overlaps with time spent doing real work.

**Architecture:** `useLibraryArtists` currently walks its followed-artist list with `for (const artist of initial) await resolveArtist(artist)` — exactly one `/api/geocode` request in flight at any moment. Because each artist first waits for the shared MusicBrainz lock and *then* does its work, the two never overlap and cadence is `lock wait + work + round trips`. Replacing the loop with N workers pulling from a shared queue lets worker B sit on the lock while worker A does its work, moving cadence toward `max(lock airtime, work)`. Nothing on the server changes: `resolveArtist` already owns its own throttled-retry loop, `updateArtist` is keyed by artist id, and the counters use functional `setState`, so out-of-order completion is already safe.

**Tech Stack:** React 19 hooks, Vitest + jsdom, `@testing-library/react` (`renderHook`, `act`, `waitFor`), Biome for lint/format.

## Global Constraints

- **Never commit directly to `main`.** Create a feature branch before the first commit and open a PR to merge it. Branch names: lowercase letters, digits and hyphens only, no `type/` prefix. Suggested: `geocode-worker-pool`.
- **Commit messages follow `~/.git-template.txt`:** a **Why**, a **How** and a **Tests** section on every commit.
- **A pre-commit hook runs `npx biome check . && npm test`.** Never bypass it with `--no-verify`. On a Biome failure run `npx biome check --write <file>`, `git add` it and re-commit.
- **Coverage thresholds are per-file and enforced in CI** (`npx vitest run --coverage`): 90% statements, 75% branches, 100% functions. `src/useLibraryArtists.js` is in the included set — every new branch needs a test.
- **No new dependencies.** Everything here is plain JavaScript.
- **Do not change anything under `api/`, `server/` or `shared/`.** The server-side throttle, the fenced lock and the metrics are already deployed and measured; this plan is client-side only.

## Context: why this change, and how big the win is

Measured in production on 2026-08-09 from `metrics:geocode` (58 cold lookups):

| metric | value |
|---|---|
| cadence p50 | 2072 ms/artist |
| handler duration p50 | 580 ms |
| single-MusicBrainz-call share | 64% |
| upstream share of handler time | 99% |

MusicBrainz lock airtime is 1100 ms for a one-call lookup and 2200 ms for a two-call one, so at the measured 64/36 mix the floor is **~1500 ms/artist**. This change is expected to move cadence from ~2072 ms to roughly **1500–1700 ms — about 25–30%**, and no further. It cannot go below ~1100 ms/artist, which is MusicBrainz's 1 req/s limit for anonymous clients. Do not tune `RESOLUTION_CONCURRENCY` upward chasing a bigger number; past the point where the lock is saturated, extra workers only add denied requests.

The warm path (every artist already in the `geo:<artistId>` Redis cache) takes no lock at all, so it benefits more freely — that path is currently 242 serialized HTTP round trips.

**This is one sequential workstream, not a parallel one.** Both tasks modify the same two files, so they must be done in order by one worker. Task 1 is a genuine prerequisite: adding workers without jitter creates a thundering herd on the shared lock.

## File Structure

- **`src/useLibraryArtists.js`** (modify) — the resolution loop. Gains a retry-jitter constant and a concurrency constant; the `for` loop in `run()` becomes a worker pool. No other responsibility changes.
- **`src/__tests__/useLibraryArtists.test.js`** (modify) — two existing tests assert the old "at most one in flight" invariant and must be updated deliberately, not deleted. New tests cover jitter and the pool.
- **`CLAUDE.md`** (modify, in Task 2) — the `src/useLibraryArtists.js` architecture bullet currently says "sequential, one-in-flight-at-a-time walk"; that becomes untrue.

---

### Task 1: Jitter the throttled retry

**Files:**
- Modify: `src/useLibraryArtists.js` (the `throttled` branch of `resolveArtist`, around line 106)
- Test: `src/__tests__/useLibraryArtists.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a module-level `const RETRY_JITTER_MS = 250;` in `src/useLibraryArtists.js`. Task 2 relies on this existing but does not import it.

**Why first:** the server hands every denied caller the lock's *exact* remaining TTL (`getThrottleRetryMs` in `server/kv.js`). That is ideal for one client and pathological for several: N workers denied during the same hold all receive nearly the same `retryAfterMs`, sleep the same duration, and wake within milliseconds of each other to fight over a lock only one can take. The losers are denied again. Jitter spreads the wake-ups.

- [ ] **Step 1: Write the failing test**

Add this to `src/__tests__/useLibraryArtists.test.js`, immediately after the existing test named `"retries the same artist after retryAfterMs when throttled, without advancing resolvedCount"`:

```js
  it("adds jitter to a throttled retry so concurrent workers do not wake together", async () => {
    vi.useFakeTimers();
    // 0.5 of the jitter window — a deterministic stand-in for the random
    // spread, so the test asserts the delay rather than the randomness.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ status: "throttled", retryAfterMs: 1000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 1,
          lng: 2,
          placeName: "Somewhere",
          resolvedAt: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useLibraryArtists("token-1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // At exactly retryAfterMs the retry must NOT have fired: waking every
    // worker on the server's exact TTL is the stampede this guards against.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 0.5 * 250ms of jitter later, it fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/useLibraryArtists.test.js -t "adds jitter"`

Expected: FAIL. The retry fires at exactly 1000 ms, so the second `expect(fetchMock).toHaveBeenCalledTimes(1)` sees 2 calls.

- [ ] **Step 3: Make the existing throttled test deterministic**

The existing test `"retries the same artist after retryAfterMs when throttled, without advancing resolvedCount"` advances timers by exactly `retryAfterMs` (5000). With jitter it would become flaky. Pin the randomness to zero so it keeps asserting what it was written to assert. Add this line directly after its `vi.useFakeTimers();`:

```js
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter: assert the base delay
```

- [ ] **Step 4: Implement the jitter**

In `src/useLibraryArtists.js`, add the constant next to the existing module-level code, above `function delay(...)`:

```js
// The server answers a denied caller with the lock's exact remaining TTL
// (server/kv.js getThrottleRetryMs). That is ideal for a single caller and
// pathological for several: every worker denied during the same hold wakes at
// the same instant to contend for a lock only one can win, and the losers are
// denied again. A small random spread staggers the wake-ups.
const RETRY_JITTER_MS = 250;
```

Then change the `throttled` branch inside `resolveArtist` from:

```js
        if (result.status === "throttled") {
          try {
            await delay(result.retryAfterMs, controller.signal);
          } catch {
            return; // aborted while waiting to retry — loop is dead, stop
          }
          continue;
        }
```

to:

```js
        if (result.status === "throttled") {
          try {
            await delay(
              result.retryAfterMs + Math.random() * RETRY_JITTER_MS,
              controller.signal,
            );
          } catch {
            return; // aborted while waiting to retry — loop is dead, stop
          }
          continue;
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/useLibraryArtists.test.js`

Expected: PASS, all tests in the file including the two touched above.

- [ ] **Step 6: Commit**

```bash
git add src/useLibraryArtists.js src/__tests__/useLibraryArtists.test.js
git commit -F - <<'EOF'
Jitter the throttled geocode retry

Why:
/api/geocode answers a denied caller with the throttle lock's exact
remaining TTL. That is the right answer for one caller and the wrong one
for several: every caller denied during the same hold wakes at the same
instant, contends for a lock only one can take, and the losers are denied
again. This lands before the worker pool that would create those callers.

How:
Add RETRY_JITTER_MS (250ms) and spread each throttled retry by a random
fraction of it, so concurrent workers wake staggered rather than together.

Tests:
New case asserting the retry has NOT fired at exactly retryAfterMs and
does fire after the jitter, with Math.random pinned for determinism. The
existing throttled-retry test pins Math.random to 0 so it keeps asserting
the base delay.
EOF
```

---

### Task 2: Bounded worker pool

**Files:**
- Modify: `src/useLibraryArtists.js` (the `for` loop at the end of `run()`, around line 163)
- Modify: `src/__tests__/useLibraryArtists.test.js` (two existing tests change meaning; two new tests)
- Modify: `CLAUDE.md` (the `src/useLibraryArtists.js` bullet)

**Interfaces:**
- Consumes: `RETRY_JITTER_MS` behaviour from Task 1 (present in the same file; nothing to import).
- Produces: a module-level `const RESOLUTION_CONCURRENCY = 4;` in `src/useLibraryArtists.js`. No exported API changes — `useLibraryArtists(token)` still returns `{ artists, resolvedCount, total, scopeMissing, failedCount }`.

**The invariant that changes:** the existing test `"aborts the in-flight geocode request on a token change, never running two requests at once"` asserts `expect(getMaxInFlight()).toBe(1)`. That is deliberately no longer true. What must stay true is that a token change aborts *every* in-flight request and starts no more for the stale loop. Update the assertion; do not delete the test.

- [ ] **Step 1: Write the failing test for concurrency**

Add to `src/__tests__/useLibraryArtists.test.js`, at the end of the `describe("useLibraryArtists")` block:

```js
  it("resolves several artists concurrently, bounded by RESOLUTION_CONCURRENCY", async () => {
    fetchFollowedArtists.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`,
        name: `Artist ${i}`,
        imageUrl: `img${i}`,
      })),
    );
    const { fetchMock, calls, getMaxInFlight } = controllableFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    // Several requests are in flight at once, and never more than the bound.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(getMaxInFlight()).toBe(4);

    // Draining the queue resolves every artist exactly once.
    for (let i = 0; i < 10; i++) {
      await waitFor(() => expect(calls[i]).toBeDefined());
      calls[i].resolve(
        jsonResponse({
          status: "resolved",
          lat: i,
          lng: i,
          placeName: `Place ${i}`,
          resolvedAt: i,
        }),
      );
    }

    await waitFor(() => expect(result.current.resolvedCount).toBe(10));
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // Never more than the bound, at any point in the run.
    expect(getMaxInFlight()).toBe(4);
    // Every artist resolved, none skipped and none done twice.
    expect(result.current.artists.every((a) => a.status === "resolved")).toBe(
      true,
    );
  });

  it("hands each artist to exactly one worker", async () => {
    fetchFollowedArtists.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `a${i}`,
        name: `Artist ${i}`,
        imageUrl: `img${i}`,
      })),
    );
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ status: "not_found", resolvedAt: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() => expect(result.current.resolvedCount).toBe(8));

    // The shared queue must not hand the same artist to two workers, nor
    // drop one: exactly 8 requests, one per distinct artist id.
    expect(fetchMock).toHaveBeenCalledTimes(8);
    const requested = fetchMock.mock.calls.map(
      ([, options]) => JSON.parse(options.body).artistId,
    );
    expect(new Set(requested).size).toBe(8);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/useLibraryArtists.test.js -t "concurrently"`

Expected: FAIL — the `waitFor` for 4 calls times out, because the sequential loop only ever issues one request until it resolves.

- [ ] **Step 3: Implement the worker pool**

In `src/useLibraryArtists.js`, add the constant next to `RETRY_JITTER_MS`:

```js
// Workers pulling from one shared queue. Sized to keep the server-side
// MusicBrainz lock busy without piling up requests that can only be denied:
// a lookup holds that lock for 1-2 intervals, so a handful of workers
// saturates it and anything beyond that just burns serverless invocations on
// throttled responses. Measured cadence floor is ~1500ms/artist regardless.
const RESOLUTION_CONCURRENCY = 4;
```

Then replace the loop at the end of `run()`:

```js
      for (const artist of initial) {
        if (!isLive()) return;
        await resolveArtist(artist);
      }
```

with:

```js
      // One shared queue, N workers. `shift()` needs no lock: JavaScript is
      // single-threaded and there is no await between the shift and the
      // check, so two workers can never take the same artist.
      const queue = [...initial];
      await Promise.all(
        Array.from({ length: RESOLUTION_CONCURRENCY }, async () => {
          while (isLive()) {
            const artist = queue.shift();
            if (!artist) return;
            await resolveArtist(artist);
          }
        }),
      );
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run src/__tests__/useLibraryArtists.test.js -t "concurrently"`

Expected: PASS.

- [ ] **Step 5: Update the two tests that asserted the old invariant**

Run the whole file: `npx vitest run src/__tests__/useLibraryArtists.test.js`

The test `"aborts the in-flight geocode request on a token change, never running two requests at once"` now fails. Rename it and update its assertions — the point of the test is the abort, not the serialism.

Change its name to:

```js
  it("aborts every in-flight geocode request on a token change and starts no more for the stale loop", async () => {
```

Its first `waitFor` currently waits for exactly one call; with a pool, both of the stale loop's artists start at once. Change:

```js
    // the stale (token-1) loop's request for a1 is in flight, unresolved
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(calls[0].options.body).toBe(
      JSON.stringify({ artistId: "a1", artistName: "Artist One" }),
    );
    expect(calls[0].options.signal.aborted).toBe(false);
```

to:

```js
    // the stale (token-1) loop has both its artists in flight, unresolved
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls[0].options.body).toBe(
      JSON.stringify({ artistId: "a1", artistName: "Artist One" }),
    );
    expect(calls.some((c) => c.options.signal.aborted)).toBe(false);
```

Change the post-rerender assertions from:

```js
    // cleanup must abort the stale request synchronously on rerender
    expect(calls[0].options.signal.aborted).toBe(true);

    // the new (token-2) loop starts fresh: a new fetchFollowedArtists call,
    // then exactly one new geocode request for its first artist
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls[1].options.body).toBe(
```

to:

```js
    // cleanup must abort EVERY stale request synchronously on rerender —
    // with a worker pool there is more than one to unwind
    expect(calls.every((c) => c.options.signal.aborted)).toBe(true);

    // the new (token-2) loop starts fresh: a new fetchFollowedArtists call,
    // then one geocode request for its single artist
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(calls[2].options.body).toBe(
```

and update the two references below it from `calls[1].resolve(` to `calls[2].resolve(`.

Finally replace the closing invariant:

```js
    // the invariant the fix guarantees: never more than one geocode request
    // in flight at once, even across a token change mid-loop
    expect(getMaxInFlight()).toBe(1);
    // and no third call was ever made for the stale loop's second artist (a2)
    expect(fetchMock).toHaveBeenCalledTimes(2);
```

with:

```js
    // The invariant is no longer "one at a time" — it is that a token change
    // leaves NOTHING from the stale loop running, and that the pool never
    // exceeds its bound.
    expect(getMaxInFlight()).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => !c.settled).length).toBe(0);
    // and the stale loop never issued a further request after the abort
    expect(fetchMock).toHaveBeenCalledTimes(3);
```

- [ ] **Step 6: Run the full file and fix any remaining fallout**

Run: `npx vitest run src/__tests__/useLibraryArtists.test.js`

Expected: PASS. If `"resolves every artist and advances resolvedCount to total (happy path)"` fails, it is because its two `mockResolvedValueOnce` responses are matched by call order and both artists now start together — the order is still a1 then a2 (workers are created in sequence and each takes the head of the queue before its first await), so it should pass unchanged. Do not loosen that test to make it pass; if it fails, the pool is dispatching out of order and that is a real bug.

- [ ] **Step 7: Run the whole suite with coverage**

Run: `npx vitest run --coverage`

Expected: PASS, 23 files. `src/useLibraryArtists.js` must still meet 90% statements / 75% branches / 100% functions. The worker arrow function is a new function — it is covered by the tests above.

- [ ] **Step 8: Update CLAUDE.md**

In `CLAUDE.md`, find the `src/useLibraryArtists.js` bullet, which reads:

> **`src/useLibraryArtists.js`** — the explore-mode resolution loop described above: `fetchFollowedArtists` (`GET /me/following?type=artist`, needs the `user-follow-read` scope) then a sequential, one-in-flight-at-a-time walk over `POST /api/geocode`, retrying `throttled` responses after the server-supplied `retryAfterMs`.

Replace it with:

> **`src/useLibraryArtists.js`** — the explore-mode resolution loop described above: `fetchFollowedArtists` (`GET /me/following?type=artist`, needs the `user-follow-read` scope) then a walk over `POST /api/geocode` driven by `RESOLUTION_CONCURRENCY` workers pulling from one shared queue, retrying `throttled` responses after the server-supplied `retryAfterMs` plus a random spread of up to `RETRY_JITTER_MS`. The jitter is not optional: the server answers every denied caller with the lock's *exact* remaining TTL, so without it concurrent workers wake in lockstep and stampede a lock only one can win. Concurrency is bounded because a lookup holds the MusicBrainz lock for 1–2 intervals — past a handful of workers the extra requests can only be denied. Measured cadence floor is ~1500 ms/artist, set by MusicBrainz's 1 req/s limit.

- [ ] **Step 9: Commit**

```bash
git add src/useLibraryArtists.js src/__tests__/useLibraryArtists.test.js CLAUDE.md
git commit -F - <<'EOF'
Resolve library artists with a bounded worker pool

Why:
The resolution loop ran one /api/geocode request at a time, so each
artist waited for the shared MusicBrainz lock and THEN did its work —
the two never overlapped. Production metrics put cadence at 2072ms per
artist against a ~1500ms floor set by the lock's own airtime; the
difference is time spent waiting with nothing else in flight.

How:
Replace the sequential for-loop with RESOLUTION_CONCURRENCY (4) workers
pulling from one shared queue. `shift()` needs no lock: JavaScript is
single-threaded and there is no await between the shift and the check.
Nothing else needed changing — resolveArtist already owns its retry
loop, updateArtist is keyed by artist id, and the counters use
functional setState, so out-of-order completion was already safe.

The old "never more than one request in flight" test asserted an
invariant this deliberately breaks. It is updated rather than deleted:
what must still hold is that a token change aborts EVERY in-flight
request and the stale loop issues no more.

Tests:
Two new cases — concurrency is real and stays within the bound, and the
shared queue hands each artist to exactly one worker (no duplicates, no
drops). The abort-on-token-change test now asserts every request is
aborted and nothing is left unsettled.
EOF
```

---

## Verification after deploy

This plan changes measured behaviour, and the instrumentation to check it is already in production. After the PR merges and deploys, resolve a library with a cold cache and compare against the pre-change baseline of **cadence p50 = 2072 ms** (2026-08-09, 58 lookups):

```
HGETALL metrics:geocode
LRANGE metrics:geocode:recent 0 499
```

Read `metrics:geocode:recent` as JSON, sort by `at`, and take the median gap between consecutive entries — ignoring gaps over 60 s, which are idle time between runs rather than slow lookups.

- **Success:** cadence p50 lands in the 1500–1700 ms range.
- **Watch:** `throttledMusicBrainz` rises relative to `count`. Some increase is expected and fine — workers discover the held lock more often. If it climbs past roughly 2 denials per lookup, `RESOLUTION_CONCURRENCY` is too high for the lock's capacity; drop it to 2 or 3 rather than adding more machinery.
- **Do not** chase a number below ~1100 ms/artist. That is MusicBrainz's 1 req/s limit for anonymous clients, and no client-side change can beat it.

Note that `LRANGE` in the Upstash console rejects a `-1` end index in some versions — use an explicit `499`, and do not paste trailing `#` comments, which the console parses as extra arguments.
