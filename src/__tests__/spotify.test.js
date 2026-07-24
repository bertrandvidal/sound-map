import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  fetchCurrentlyPlaying,
  pause,
  play,
  skipToNext,
} from "../spotify.js";

describe("buildAuthUrl", () => {
  it("returns a Spotify authorize URL with required params", () => {
    const url = buildAuthUrl();
    expect(url).toContain("https://accounts.spotify.com/authorize");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=user-read-currently-playing");
    // URLSearchParams encodes the space between scopes as "+".
    expect(url).toContain(
      "user-read-currently-playing+user-modify-playback-state",
    );
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain(
      encodeURIComponent("http://127.0.0.1:3000/api/callback"),
    );
  });

  it("uses VITE_REDIRECT_URI when set (production)", () => {
    vi.stubEnv("VITE_REDIRECT_URI", "https://app.vercel.app/api/callback");
    const url = buildAuthUrl();
    expect(url).toContain(
      encodeURIComponent("https://app.vercel.app/api/callback"),
    );
    vi.unstubAllEnvs();
  });
});

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
});
