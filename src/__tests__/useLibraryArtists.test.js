import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFollowedArtists } from "../spotify.js";
import { useLibraryArtists } from "../useLibraryArtists.js";

vi.mock("../spotify.js", () => ({
  fetchFollowedArtists: vi.fn(),
}));

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

// A fetch mock whose promises stay pending until `resolve()` is called
// explicitly, and which honors AbortSignal like real fetch (rejects with an
// AbortError and stops counting as in-flight the moment its signal aborts).
// Tracks the high-water mark of concurrently in-flight calls so a test can
// assert the "at most one in flight" invariant directly, not just infer it
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

  it("treats a non-200 /api/geocode response as a resolution failure and moves on", async () => {
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

    await waitFor(() => expect(result.current.resolvedCount).toBe(2));
    expect(result.current.artists[0].status).toBe("not_found");
    expect(result.current.artists[1].status).toBe("resolved");
  });

  it("treats a network-level fetch failure as a resolution failure and moves on", async () => {
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

    await waitFor(() => expect(result.current.resolvedCount).toBe(2));
    expect(result.current.artists[0].status).toBe("not_found");
    expect(result.current.artists[1].status).toBe("resolved");
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

  it("aborts the in-flight geocode request on a token change, never running two requests at once", async () => {
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

    // the stale (token-1) loop's request for a1 is in flight, unresolved
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(calls[0].options.body).toBe(
      JSON.stringify({ artistId: "a1", artistName: "Artist One" }),
    );
    expect(calls[0].options.signal.aborted).toBe(false);

    // simulate the routine TOKEN_EXPIRED refresh in MapView.jsx: the token
    // prop changes while a geocode call for the OLD token is still pending
    rerender({ token: "token-2" });

    // cleanup must abort the stale request synchronously on rerender
    expect(calls[0].options.signal.aborted).toBe(true);

    // the new (token-2) loop starts fresh: a new fetchFollowedArtists call,
    // then exactly one new geocode request for its first artist
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls[1].options.body).toBe(
      JSON.stringify({ artistId: "b1", artistName: "Artist B" }),
    );

    calls[1].resolve(
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

    // the invariant the fix guarantees: never more than one geocode request
    // in flight at once, even across a token change mid-loop
    expect(getMaxInFlight()).toBe(1);
    // and no third call was ever made for the stale loop's second artist (a2)
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    fetchFollowedArtists.mockResolvedValue([
      { id: "a1", name: "Artist One", imageUrl: "img1" },
      { id: "a2", name: "Artist Two", imageUrl: "img2" },
    ]);

    let resolveFirst;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(firstResponse);
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() => useLibraryArtists("token-1"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      resolveFirst(
        jsonResponse({
          status: "resolved",
          lat: 1,
          lng: 1,
          placeName: "Too late",
          resolvedAt: 1,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // the loop must not continue to the second artist after unmount
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
