import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFollowedArtists } from "../spotify.js";
import { parseConcurrency, useLibraryArtists } from "../useLibraryArtists.js";

vi.mock("../spotify.js", () => ({
  fetchFollowedArtists: vi.fn(),
}));

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// Mirrors DEFAULT_RESOLUTION_CONCURRENCY in useLibraryArtists.js. The hook
// bakes its value in at build time from VITE_RESOLUTION_CONCURRENCY, so the
// tests below assert against the default the suite runs under.
const CONCURRENCY = 2;

// A fetch mock whose promises stay pending until `resolve()` is called
// explicitly, and which honors AbortSignal like real fetch (rejects with an
// AbortError and stops counting as in-flight the moment its signal aborts).
// Tracks the high-water mark of concurrently in-flight calls so a test can
// assert the worker pool's concurrency bound directly, not just infer it
// from call counts.
function controllableFetch() {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchMock = vi.fn((url, options) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve, reject) => {
      const entry = { url, options, settled: false };
      entry.resolve = (value) => {
        if (entry.settled) return;
        entry.settled = true;
        inFlight--;
        resolve(value);
      };
      options.signal.addEventListener("abort", () => {
        if (entry.settled) return;
        entry.settled = true;
        inFlight--;
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      });
      calls.push(entry);
    });
  });
  return { fetchMock, calls, getMaxInFlight: () => maxInFlight };
}

// VITE_RESOLUTION_CONCURRENCY is substituted at build time, so the module's
// own constant can't be re-read per test. The parsing is tested directly
// instead — that's where every branch worth guarding actually lives.
describe("parseConcurrency", () => {
  it("uses the value when it is a positive integer", () => {
    expect(parseConcurrency("3")).toBe(3);
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("12")).toBe(12);
  });

  it("falls back when unset or empty", () => {
    expect(parseConcurrency(undefined)).toBe(2);
    expect(parseConcurrency("")).toBe(2);
  });

  it("falls back rather than stalling the loop on a nonsensical value", () => {
    // 0 would spawn no workers at all and silently resolve nothing; a
    // negative is the same bug wearing a different sign.
    expect(parseConcurrency("0")).toBe(2);
    expect(parseConcurrency("-1")).toBe(2);
    expect(parseConcurrency("abc")).toBe(2);
  });

  it("honors an explicit fallback", () => {
    expect(parseConcurrency(undefined, 5)).toBe(5);
  });
});

describe("useLibraryArtists", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves every artist and advances resolvedCount to total (happy path)", async () => {
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
      { id: "a2", name: "Artist Two", imageUrl: "img2" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 1,
          lng: 2,
          placeName: "Place One",
          resolvedAt: 111,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 3,
          lng: 4,
          placeName: "Place Two",
          resolvedAt: 222,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() => expect(result.current.resolvedCount).toBe(2));

    expect(result.current.total).toBe(2);
    expect(result.current.scopeMissing).toBe(false);
    expect(result.current.artists).toEqual([
      {
        id: "a1",
        name: "Artist One",
        imageUrl: "img1",
        status: "resolved",
        lat: 1,
        lng: 2,
        placeName: "Place One",
      },
      {
        id: "a2",
        name: "Artist Two",
        imageUrl: "img2",
        status: "resolved",
        lat: 3,
        lng: 4,
        placeName: "Place Two",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/geocode",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ artistId: "a1", artistName: "Artist One" }),
      }),
    );
  });

  it("retries the same artist after retryAfterMs when throttled, without advancing resolvedCount", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter: assert the base delay
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ status: "throttled", retryAfterMs: 5000 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 9,
          lng: 8,
          placeName: "Eventually",
          resolvedAt: 333,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.resolvedCount).toBe(0);
    expect(result.current.artists[0].status).toBe("pending");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.resolvedCount).toBe(1);
    expect(result.current.artists[0]).toMatchObject({
      status: "resolved",
      lat: 9,
      lng: 8,
      placeName: "Eventually",
    });
  });

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

  it("advances resolvedCount for a not_found artist", async () => {
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ status: "not_found", resolvedAt: 111 }),
        ),
    );

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() => expect(result.current.resolvedCount).toBe(1));
    expect(result.current.artists[0].status).toBe("not_found");
  });

  it("treats a non-200 /api/geocode response as a backend failure, not a legitimate not_found", async () => {
    // A raw 500 (e.g. an Upstash outage — see api/geocode.js's Redis
    // try/catch) must not be indistinguishable from a genuine "no location
    // found" result: it must not be recorded as not_found and must not
    // count toward resolvedCount, or a backend outage would make the whole
    // library read as "resolved successfully, and it's empty" (see
    // LibraryLoadingBadge, which hides once resolvedCount reaches total).
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
      { id: "a2", name: "Artist Two", imageUrl: "img2" },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 1,
          lng: 1,
          placeName: "Fine",
          resolvedAt: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() =>
      expect(result.current.artists[1]?.status).toBe("resolved"),
    );
    expect(result.current.artists[0].status).toBe("unavailable");
    expect(result.current.resolvedCount).toBe(1);
    expect(result.current.failedCount).toBe(1);
  });

  it("treats a network-level fetch failure the same way — a backend failure, not a not_found", async () => {
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
      { id: "a2", name: "Artist Two", imageUrl: "img2" },
    ]);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 5,
          lng: 6,
          placeName: "Fine",
          resolvedAt: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() =>
      expect(result.current.artists[1]?.status).toBe("resolved"),
    );
    expect(result.current.artists[0].status).toBe("unavailable");
    expect(result.current.resolvedCount).toBe(1);
    expect(result.current.failedCount).toBe(1);
  });

  it("resets failedCount when the loop restarts on a token change", async () => {
    fetchFollowedArtists
      .mockResolvedValueOnce([
        { id: "a1", name: "Artist One", imageUrl: "img1" },
      ])
      .mockResolvedValueOnce([
        { id: "b1", name: "Artist B", imageUrl: "imgB" },
      ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(
        jsonResponse({
          status: "resolved",
          lat: 1,
          lng: 1,
          placeName: "B Place",
          resolvedAt: 1,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ token }) => useLibraryArtists(token),
      { initialProps: { token: "token-1" } },
    );

    await waitFor(() => expect(result.current.failedCount).toBe(1));

    rerender({ token: "token-2" });

    await waitFor(() => expect(result.current.resolvedCount).toBe(1));
    expect(result.current.failedCount).toBe(0);
  });

  it("sets scopeMissing and fires no geocode calls when fetchFollowedArtists throws SPOTIFY_ERROR:403", async () => {
    fetchFollowedArtists.mockRejectedValue(new Error("SPOTIFY_ERROR:403"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() => expect(result.current.scopeMissing).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.total).toBe(0);
    expect(result.current.resolvedCount).toBe(0);
  });

  it("aborts every in-flight geocode request on a token change and starts no more for the stale loop", async () => {
    fetchFollowedArtists
      .mockResolvedValueOnce([
        { id: "a1", name: "Artist One", imageUrl: "img1" },
        { id: "a2", name: "Artist Two", imageUrl: "img2" },
      ])
      .mockResolvedValueOnce([
        { id: "b1", name: "Artist B", imageUrl: "imgB" },
      ]);
    const { fetchMock, calls, getMaxInFlight } = controllableFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ token }) => useLibraryArtists(token),
      { initialProps: { token: "token-1" } },
    );

    // the stale (token-1) loop has both its artists in flight, unresolved
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls[0].options.body).toBe(
      JSON.stringify({ artistId: "a1", artistName: "Artist One" }),
    );
    expect(calls.some((c) => c.options.signal.aborted)).toBe(false);

    // simulate the routine TOKEN_EXPIRED refresh in MapView.jsx: the token
    // prop changes while a geocode call for the OLD token is still pending
    rerender({ token: "token-2" });

    // cleanup must abort EVERY stale request synchronously on rerender —
    // with a worker pool there is more than one to unwind
    expect(calls.every((c) => c.options.signal.aborted)).toBe(true);

    // the new (token-2) loop starts fresh: a new fetchFollowedArtists call,
    // then one geocode request for its single artist
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(calls[2].options.body).toBe(
      JSON.stringify({ artistId: "b1", artistName: "Artist B" }),
    );

    calls[2].resolve(
      jsonResponse({
        status: "resolved",
        lat: 1,
        lng: 1,
        placeName: "B Place",
        resolvedAt: 1,
      }),
    );

    await waitFor(() => expect(result.current.resolvedCount).toBe(1));

    // state reflects only the new token's loop — the stale artists never
    // appear, and the aborted request never advanced resolvedCount or
    // marked anything not_found
    expect(result.current.total).toBe(1);
    expect(result.current.artists).toEqual([
      {
        id: "b1",
        name: "Artist B",
        imageUrl: "imgB",
        status: "resolved",
        lat: 1,
        lng: 1,
        placeName: "B Place",
      },
    ]);

    // The invariant is no longer "one at a time" — it is that a token change
    // leaves NOTHING from the stale loop running, and that the pool never
    // exceeds its bound.
    expect(getMaxInFlight()).toBeLessThanOrEqual(CONCURRENCY);
    expect(calls.filter((c) => !c.settled).length).toBe(0);
    // and the stale loop never issued a further request after the abort
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels a pending throttled-retry timer on a token change instead of firing a stale retry", async () => {
    vi.useFakeTimers();
    fetchFollowedArtists
      .mockResolvedValueOnce([
        { id: "a1", name: "Artist One", imageUrl: "img1" },
      ])
      .mockResolvedValueOnce([
        { id: "b1", name: "Artist B", imageUrl: "imgB" },
      ]);
    const { fetchMock, calls } = controllableFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ token }) => useLibraryArtists(token),
      { initialProps: { token: "token-1" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // a1 comes back throttled — the hook is now waiting out a 5s timer
    calls[0].resolve(jsonResponse({ status: "throttled", retryAfterMs: 5000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // token changes well before the 5s retry timer would fire
    await act(async () => {
      rerender({ token: "token-2" });
      await vi.advanceTimersByTimeAsync(0);
    });

    // the new loop makes its own request for b1 (call #2) without ever
    // firing a retry for the stale a1 (which would also be call #2 if the
    // timer had not been cancelled — so this also proves the timer is dead)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1].options.body).toBe(
      JSON.stringify({ artistId: "b1", artistName: "Artist B" }),
    );

    // advancing well past the original 5s mark fires no further calls —
    // proof the stale setTimeout was actually cleared, not just ignored
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.resolvedCount).toBe(0);
    expect(result.current.artists).toEqual([
      { id: "b1", name: "Artist B", imageUrl: "imgB", status: "pending" },
    ]);
  });

  it("does not update state or warn after unmounting mid-loop", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    // More artists than the pool has workers, so once every worker is busy
    // there are still queued artists nobody may pull after the unmount.
    fetchFollowedArtists.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `a${i}`,
        name: `Artist ${i}`,
        imageUrl: `img${i}`,
      })),
    );

    // Deliberately ignores the AbortSignal, so every in-flight request
    // settles *successfully* after unmount — the case where a late response
    // could still call setState on an unmounted hook.
    const settle = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          settle.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useLibraryArtists("token-1"));

    // every worker is busy; the rest of the queue is untouched
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(CONCURRENCY));

    unmount();

    await act(async () => {
      for (const resolveCall of settle) {
        resolveCall(
          jsonResponse({
            status: "resolved",
            lat: 1,
            lng: 1,
            placeName: "Too late",
            resolvedAt: 1,
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 0));
    });

    // no worker pulled another artist off the queue after unmount
    expect(fetchMock).toHaveBeenCalledTimes(CONCURRENCY);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(CONCURRENCY));
    expect(getMaxInFlight()).toBe(CONCURRENCY);

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
    expect(getMaxInFlight()).toBe(CONCURRENCY);
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "not_found", resolvedAt: 1 }));
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
});
