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
