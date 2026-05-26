import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthUrl, fetchCurrentlyPlaying } from "../spotify.js";

describe("buildAuthUrl", () => {
  it("returns a Spotify authorize URL with required params", () => {
    const url = buildAuthUrl();
    expect(url).toContain("https://accounts.spotify.com/authorize");
    expect(url).toContain("response_type=code");
    expect(url).toContain("scope=user-read-currently-playing");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain(encodeURIComponent("http://127.0.0.1:3000/callback"));
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
            item: {
              name: "HUMBLE.",
              artists: [{ name: "Kendrick Lamar" }],
              album: { images: [{ url: "https://example.com/art.jpg" }] },
            },
          }),
      }),
    );
    expect(await fetchCurrentlyPlaying("token")).toEqual({
      trackName: "HUMBLE.",
      artistName: "Kendrick Lamar",
      albumImageUrl: "https://example.com/art.jpg",
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
