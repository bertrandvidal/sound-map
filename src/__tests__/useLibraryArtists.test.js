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
