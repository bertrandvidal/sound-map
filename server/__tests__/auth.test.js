import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionCookie,
  COOKIE_NAME,
  clearSessionCookie,
  exchangeAuthCode,
  exchangeRefreshToken,
  openToken,
  parseCookies,
  sealToken,
} from "../auth.js";

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

  it("falls back to the raw value when a cookie value is malformed", () => {
    expect(parseCookies("sid=%")).toEqual({ sid: "%" });
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

describe("exchangeAuthCode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const CREDS = {
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1:3000/callback",
  };

  it("returns the refresh token on a Spotify 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const result = await exchangeAuthCode("auth-code", CREDS);
    expect(result).toEqual({ refreshToken: "refresh-abc" });
  });

  it("throws when Spotify returns a non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    await expect(exchangeAuthCode("bad", CREDS)).rejects.toThrow(
      "AUTH_CODE_EXCHANGE_FAILED:400",
    );
  });

  it("throws when the response has no refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "only-access" }),
      }),
    );
    await expect(exchangeAuthCode("code", CREDS)).rejects.toThrow(
      "AUTH_CODE_EXCHANGE_FAILED:no_refresh_token",
    );
  });
});

describe("sealToken / openToken", () => {
  beforeEach(() => {
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("round-trips a plaintext token", () => {
    const sealed = sealToken("refresh-abc");
    expect(sealed).not.toContain("refresh-abc");
    expect(openToken(sealed)).toBe("refresh-abc");
  });

  it("produces a different sealed blob each call (random IV)", () => {
    expect(sealToken("same")).not.toBe(sealToken("same"));
  });

  it("throws when the ciphertext is tampered with", () => {
    const sealed = sealToken("refresh-abc");
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] ^= 0xff; // flip last byte of ciphertext
    const tampered = bytes.toString("base64url");
    expect(() => openToken(tampered)).toThrow();
  });

  it("throws when opened with a different key", () => {
    const sealed = sealToken("refresh-abc");
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => openToken(sealed)).toThrow();
  });

  it("throws when the key is missing", () => {
    process.env.COOKIE_ENCRYPTION_KEY = "";
    expect(() => sealToken("x")).toThrow(/COOKIE_ENCRYPTION_KEY/);
  });

  it("throws when the key does not decode to 32 bytes", () => {
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => sealToken("x")).toThrow(/32 bytes/);
  });

  it("exposes the unified cookie name", () => {
    expect(COOKIE_NAME).toBe("rt");
  });
});

describe("buildSessionCookie", () => {
  it("emits the sealed value with the shared attributes", () => {
    const cookie = buildSessionCookie("SEALED", { secure: true });
    expect(cookie).toMatch(/^rt=SEALED/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/Secure/);
  });

  it("omits Secure when secure is false (local http)", () => {
    const cookie = buildSessionCookie("SEALED", { secure: false });
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie with Max-Age=0", () => {
    const cookie = clearSessionCookie({ secure: true });
    expect(cookie).toMatch(/^rt=;/);
    expect(cookie).toMatch(/Max-Age=0/);
    expect(cookie).toMatch(/Secure/);
  });
});
