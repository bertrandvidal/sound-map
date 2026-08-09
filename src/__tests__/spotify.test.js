import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCurrentlyPlaying,
  fetchDevices,
  fetchFollowedArtists,
  pause,
  play,
  skipToNext,
} from "../spotify.js";

describe("fetchCurrentlyPlaying", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when nothing is playing (HTTP 204)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 204,
        ok: false,
        headers: { get: () => null },
      }),
    );
    expect(await fetchCurrentlyPlaying("token")).toBeNull();
  });

  it("throws TOKEN_EXPIRED on HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        headers: { get: () => null },
      }),
    );
    await expect(fetchCurrentlyPlaying("token")).rejects.toThrow(
      "TOKEN_EXPIRED",
    );
  });

  it("throws RATE_LIMITED with retry seconds on HTTP 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 429,
        ok: false,
        headers: { get: () => "10" },
      }),
    );
    await expect(fetchCurrentlyPlaying("token")).rejects.toThrow(
      "RATE_LIMITED:10",
    );
  });

  it("returns null when item is null (Spotify says playing but no track)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ item: null }),
      }),
    );
    expect(await fetchCurrentlyPlaying("token")).toBeNull();
  });

  it("returns structured track data when a track is playing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            is_playing: true,
            progress_ms: 1234,
            item: {
              id: "track-123",
              name: "HUMBLE.",
              duration_ms: 177000,
              artists: [{ name: "Kendrick Lamar" }, { name: "SZA" }],
              album: { images: [{ url: "https://example.com/art.jpg" }] },
            },
          }),
      }),
    );
    expect(await fetchCurrentlyPlaying("token")).toEqual({
      trackName: "HUMBLE.",
      artistName: "Kendrick Lamar",
      artistNames: "Kendrick Lamar, SZA",
      albumImageUrl: "https://example.com/art.jpg",
      trackId: "track-123",
      isPlaying: true,
      progressMs: 1234,
      durationMs: 177000,
    });
  });

  it("throws SPOTIFY_ERROR on unexpected HTTP status (e.g. 503)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 503,
        ok: false,
        headers: { get: () => null },
      }),
    );
    await expect(fetchCurrentlyPlaying("token")).rejects.toThrow(
      "SPOTIFY_ERROR:503",
    );
  });
});

describe("player controls (play / pause / skipToNext)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const stub = (response) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

  it("play resolves on HTTP 204", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await expect(play("token")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/me/player/play",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("pause resolves on HTTP 204", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await expect(pause("token")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/me/player/pause",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("skipToNext resolves on HTTP 204", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await expect(skipToNext("token")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/me/player/next",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws TOKEN_EXPIRED on HTTP 401", async () => {
    stub({ status: 401, ok: false, headers: { get: () => null } });
    await expect(play("token")).rejects.toThrow("TOKEN_EXPIRED");
  });

  it("throws PLAYBACK_UNAVAILABLE on HTTP 403 (non-Premium / restricted)", async () => {
    stub({ status: 403, ok: false, headers: { get: () => null } });
    await expect(pause("token")).rejects.toThrow("PLAYBACK_UNAVAILABLE");
  });

  it("throws NO_ACTIVE_DEVICE on HTTP 404", async () => {
    stub({ status: 404, ok: false, headers: { get: () => null } });
    await expect(skipToNext("token")).rejects.toThrow("NO_ACTIVE_DEVICE");
  });

  it("throws RATE_LIMITED with retry seconds on HTTP 429", async () => {
    stub({ status: 429, ok: false, headers: { get: () => "7" } });
    await expect(play("token")).rejects.toThrow("RATE_LIMITED:7");
  });

  it("throws RATE_LIMITED with default when Retry-After is absent", async () => {
    stub({ status: 429, ok: false, headers: { get: () => null } });
    await expect(play("token")).rejects.toThrow("RATE_LIMITED:5");
  });

  it("throws SPOTIFY_ERROR on unexpected HTTP status (e.g. 500)", async () => {
    stub({ status: 500, ok: false, headers: { get: () => null } });
    await expect(skipToNext("token")).rejects.toThrow("SPOTIFY_ERROR:500");
  });

  it("play with no contextUri sends no body and no Content-Type header", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await play("token");
    const callArgs = fetch.mock.calls[0];
    const url = callArgs[0];
    const init = callArgs[1];
    expect(url).toBe("https://api.spotify.com/v1/me/player/play");
    expect(init).toEqual({
      method: "PUT",
      headers: { Authorization: "Bearer token" },
    });
  });

  it("play with contextUri sends body and Content-Type header", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await play("token", { contextUri: "spotify:artist:123" });
    const callArgs = fetch.mock.calls[0];
    const url = callArgs[0];
    const init = callArgs[1];
    expect(url).toBe("https://api.spotify.com/v1/me/player/play");
    expect(init).toEqual({
      method: "PUT",
      headers: {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
      body: '{"context_uri":"spotify:artist:123"}',
    });
  });

  it("pause does not send body or Content-Type header", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await pause("token");
    const callArgs = fetch.mock.calls[0];
    const init = callArgs[1];
    expect(init).toEqual({
      method: "PUT",
      headers: { Authorization: "Bearer token" },
    });
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("skipToNext does not send body or Content-Type header", async () => {
    stub({ status: 204, ok: true, headers: { get: () => null } });
    await skipToNext("token");
    const callArgs = fetch.mock.calls[0];
    const init = callArgs[1];
    expect(init).toEqual({
      method: "POST",
      headers: { Authorization: "Bearer token" },
    });
    expect(init.body).toBeUndefined();
    expect(init.headers["Content-Type"]).toBeUndefined();
  });
});

describe("fetchDevices", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const ok = (body) =>
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => body,
      }),
    );

  it("returns the device list", async () => {
    ok({ devices: [{ id: "d1", name: "Laptop", is_active: false }] });
    await expect(fetchDevices("token")).resolves.toEqual([
      { id: "d1", name: "Laptop", is_active: false },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/me/player/devices",
      { headers: { Authorization: "Bearer token" } },
    );
  });

  it("returns [] when Spotify omits the devices key", async () => {
    ok({});
    await expect(fetchDevices("token")).resolves.toEqual([]);
  });

  it("throws INSUFFICIENT_SCOPE on 403, not PLAYBACK_UNAVAILABLE", async () => {
    // A session minted before user-read-playback-state was requested. This
    // is stale consent, not a missing Premium subscription — conflating them
    // would tell the user to buy something they already have.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 403,
        ok: false,
        headers: { get: () => null },
      }),
    );
    await expect(fetchDevices("token")).rejects.toThrow("INSUFFICIENT_SCOPE");
  });

  it("throws TOKEN_EXPIRED on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        headers: { get: () => null },
      }),
    );
    await expect(fetchDevices("token")).rejects.toThrow("TOKEN_EXPIRED");
  });
});

describe("play device fallback (no active device)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const noDevice = { status: 404, ok: false, headers: { get: () => null } };
  const success = { status: 204, ok: true, headers: { get: () => null } };
  const devices = (list) => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({ devices: list }),
  });

  it("retries against a reachable device when the bare play call 404s", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noDevice)
      .mockResolvedValueOnce(devices([{ id: "d1", is_active: false }]))
      .mockResolvedValueOnce(success);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      play("token", { contextUri: "spotify:artist:123" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.spotify.com/v1/me/player/play?device_id=d1",
    );
    // the retry must carry the same context, or it would start the wrong music
    expect(fetchMock.mock.calls[2][1].body).toBe(
      '{"context_uri":"spotify:artist:123"}',
    );
  });

  it("prefers an already-active device and skips restricted ones", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noDevice)
      .mockResolvedValueOnce(
        devices([
          // is_restricted devices accept no Web API commands, so targeting
          // one would turn a visible 404 into a silent no-op.
          { id: "restricted", is_restricted: true, is_active: true },
          { id: "idle", is_active: false },
          { id: "active", is_active: true },
        ]),
      )
      .mockResolvedValueOnce(success);
    vi.stubGlobal("fetch", fetchMock);

    await play("token");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.spotify.com/v1/me/player/play?device_id=active",
    );
  });

  it("rethrows NO_ACTIVE_DEVICE when nothing is open anywhere", async () => {
    // No API call can fix this — the user has to open Spotify — so the error
    // keeps its original meaning for MapView to turn into that instruction.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noDevice)
      .mockResolvedValueOnce(devices([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(play("token")).rejects.toThrow("NO_ACTIVE_DEVICE");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows NO_ACTIVE_DEVICE when every device is restricted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noDevice)
      .mockResolvedValueOnce(devices([{ id: "r", is_restricted: true }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(play("token")).rejects.toThrow("NO_ACTIVE_DEVICE");
  });

  it("surfaces INSUFFICIENT_SCOPE from the device lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(noDevice)
      .mockResolvedValueOnce({
        status: 403,
        ok: false,
        headers: { get: () => null },
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(play("token")).rejects.toThrow("INSUFFICIENT_SCOPE");
  });

  it("does not re-resolve when an explicit deviceId 404s", async () => {
    // An explicit device that 404s is dead, not missing — re-resolving would
    // consult the same list and could pick it again.
    const fetchMock = vi.fn().mockResolvedValueOnce(noDevice);
    vi.stubGlobal("fetch", fetchMock);

    await expect(play("token", { deviceId: "d9" })).rejects.toThrow(
      "NO_ACTIVE_DEVICE",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.spotify.com/v1/me/player/play?device_id=d9",
    );
  });

  it("does not consult devices for a non-404 failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 403,
      ok: false,
      headers: { get: () => null },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(play("token")).rejects.toThrow("PLAYBACK_UNAVAILABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchFollowedArtists", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a single page of followed artists when after is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: () =>
          Promise.resolve({
            artists: {
              items: [
                {
                  id: "artist-1",
                  name: "Artist One",
                  images: [{ url: "https://example.com/artist1.jpg" }],
                },
                {
                  id: "artist-2",
                  name: "Artist Two",
                  images: [],
                },
              ],
              cursors: { after: null },
            },
          }),
      }),
    );
    const result = await fetchFollowedArtists("token");
    expect(result).toEqual([
      {
        id: "artist-1",
        name: "Artist One",
        imageUrl: "https://example.com/artist1.jpg",
      },
      { id: "artist-2", name: "Artist Two", imageUrl: null },
    ]);
  });

  it("paginates through multiple pages of followed artists", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // First page
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          artists: {
            items: [
              {
                id: "artist-1",
                name: "Artist One",
                images: [{ url: "https://example.com/artist1.jpg" }],
              },
            ],
            cursors: { after: "cursor-page-1" },
          },
        }),
    });

    // Second page
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () =>
        Promise.resolve({
          artists: {
            items: [
              {
                id: "artist-2",
                name: "Artist Two",
                images: [{ url: "https://example.com/artist2.jpg" }],
              },
            ],
            cursors: { after: null },
          },
        }),
    });

    const result = await fetchFollowedArtists("token");
    expect(result).toEqual([
      {
        id: "artist-1",
        name: "Artist One",
        imageUrl: "https://example.com/artist1.jpg",
      },
      {
        id: "artist-2",
        name: "Artist Two",
        imageUrl: "https://example.com/artist2.jpg",
      },
    ]);

    // Verify second call includes the after cursor
    const secondCall = mockFetch.mock.calls[1][0];
    expect(secondCall.toString()).toContain("after=cursor-page-1");
  });

  it("throws TOKEN_EXPIRED on HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 401,
        ok: false,
        headers: { get: () => null },
      }),
    );
    await expect(fetchFollowedArtists("token")).rejects.toThrow(
      "TOKEN_EXPIRED",
    );
  });

  it("throws RATE_LIMITED with retry seconds on HTTP 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 429,
        ok: false,
        headers: { get: () => "15" },
      }),
    );
    await expect(fetchFollowedArtists("token")).rejects.toThrow(
      "RATE_LIMITED:15",
    );
  });

  it("throws SPOTIFY_ERROR on HTTP 403 (stale pre-scope session)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 403,
        ok: false,
        headers: { get: () => null },
      }),
    );
    await expect(fetchFollowedArtists("token")).rejects.toThrow(
      "SPOTIFY_ERROR:403",
    );
  });
});
