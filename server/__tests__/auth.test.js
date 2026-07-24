import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  buildSessionCookie,
  buildStateCookie,
  COOKIE_NAME,
  clearSessionCookie,
  clearStateCookie,
  createSession,
  exchangeAuthCode,
  exchangeRefreshToken,
  openSession,
  openToken,
  parseCookies,
  refreshSession,
  STATE_COOKIE_NAME,
  sealSession,
  sealToken,
} from "../auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
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
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    expect(() => openToken(sealed)).toThrow();
  });

  it("throws when the key is missing", () => {
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", "");
    expect(() => sealToken("x")).toThrow(/COOKIE_ENCRYPTION_KEY/);
  });

  it("throws when the key does not decode to 32 bytes", () => {
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(16, 1).toString("base64"));
    expect(() => sealToken("x")).toThrow(/32 bytes/);
  });

  it("exposes the unified cookie name", () => {
    expect(COOKIE_NAME).toBe("rt");
  });
});

describe("sealSession / openSession", () => {
  beforeEach(() => {
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  });

  it("round-trips the refresh token", () => {
    const sealed = sealSession("refresh-abc");
    expect(openSession(sealed)).toBe("refresh-abc");
  });

  it("accepts a session younger than 30 days", () => {
    const issued = 1_000_000_000_000;
    const sealed = sealSession("refresh-abc", issued);
    expect(openSession(sealed, issued + 29 * DAY_MS)).toBe("refresh-abc");
  });

  it("rejects a session older than 30 days", () => {
    const issued = 1_000_000_000_000;
    const sealed = sealSession("refresh-abc", issued);
    expect(() => openSession(sealed, issued + 31 * DAY_MS)).toThrow(
      /SESSION_EXPIRED/,
    );
  });

  it("rejects a legacy seal that holds a raw token instead of a payload", () => {
    const sealed = sealToken("refresh-abc");
    expect(() => openSession(sealed)).toThrow();
  });

  it("rejects a sealed payload missing the expected fields", () => {
    const sealed = sealToken(JSON.stringify({ unexpected: true }));
    expect(() => openSession(sealed)).toThrow(/SESSION_INVALID/);
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

  it("omits Secure when secure is false", () => {
    const cookie = clearSessionCookie({ secure: false });
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).toMatch(/Max-Age=0/);
  });
});

describe("state cookie", () => {
  it("exposes the state cookie name", () => {
    expect(STATE_COOKIE_NAME).toBe("oauth_state");
  });

  it("buildStateCookie emits a short-lived HttpOnly cookie", () => {
    const cookie = buildStateCookie("state-123", { secure: true });
    expect(cookie).toMatch(/^oauth_state=state-123/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/Secure/);
  });

  it("clearStateCookie expires the cookie", () => {
    const cookie = clearStateCookie({ secure: true });
    expect(cookie).toMatch(/^oauth_state=;/);
    expect(cookie).toMatch(/Max-Age=0/);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the Spotify authorize URL with the state threaded through", () => {
    const url = buildAuthorizeUrl({
      clientId: "id",
      redirectUri: "https://app.vercel.app/api/callback",
      state: "state-123",
    });
    expect(url).toContain("https://accounts.spotify.com/authorize?");
    expect(url).toContain("client_id=id");
    expect(url).toContain("response_type=code");
    expect(url).toContain("state=state-123");
    // URLSearchParams encodes the space between scopes as "+".
    expect(url).toContain(
      "user-read-currently-playing+user-modify-playback-state",
    );
    expect(url).toContain(
      encodeURIComponent("https://app.vercel.app/api/callback"),
    );
  });
});

describe("createSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  });

  it("exchanges the code and returns a sealed session cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const { cookie } = await createSession("auth-code", {
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "http://127.0.0.1:3000/callback",
      secure: true,
    });
    expect(cookie).toMatch(/^rt=/);
    expect(cookie).toMatch(/Secure/);
    // the sealed value must not leak the plaintext refresh token
    expect(cookie).not.toContain("refresh-abc");
  });
});

describe("refreshSession", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  });

  it("returns an access token and no cookie when the token did not rotate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh", expires_in: 3600 }),
      }),
    );
    const sealed = sealSession("refresh-abc");
    const result = await refreshSession(sealed, {
      clientId: "id",
      clientSecret: "secret",
      secure: false,
    });
    expect(result.accessToken).toBe("fresh");
    expect(result.expiresIn).toBe(3600);
    expect(result.cookie).toBeNull();
  });

  it("re-issues a cookie when Spotify rotates the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fresh",
            expires_in: 3600,
            refresh_token: "rotated",
          }),
      }),
    );
    const sealed = sealSession("refresh-abc");
    const result = await refreshSession(sealed, {
      clientId: "id",
      clientSecret: "secret",
      secure: true,
    });
    expect(result.cookie).toMatch(/^rt=/);
    expect(result.cookie).toMatch(/Secure/);
  });

  it("rejects a session sealed more than 30 days ago without calling Spotify", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sealed = sealSession("refresh-abc", Date.now() - 31 * DAY_MS);
    await expect(
      refreshSession(sealed, {
        clientId: "id",
        clientSecret: "secret",
        secure: false,
      }),
    ).rejects.toThrow(/SESSION_EXPIRED/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws when the sealed cookie is invalid", async () => {
    await expect(
      refreshSession("not-a-valid-sealed-blob", {
        clientId: "id",
        clientSecret: "secret",
        secure: false,
      }),
    ).rejects.toThrow();
  });
});
