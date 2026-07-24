import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealToken } from "../../server/auth.js";
import callback from "../callback.js";
import logout from "../logout.js";
import refresh from "../refresh.js";

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    redirected: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    redirect(url) {
      this.redirected = url;
      return this;
    },
  };
}

// Restore any env vars stubbed per-test so nothing leaks between tests.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("api/callback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "id");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "secret");
    vi.stubEnv("REDIRECT_URI", "https://app.vercel.app/api/callback");
    vi.stubEnv("FRONTEND_URL", "https://app.vercel.app");
  });

  it("seals the refresh token into a Secure cookie and redirects home", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const res = mockRes();
    await callback({ query: { code: "auth-code" } }, res);
    expect(res.headers["Set-Cookie"]).toMatch(/^rt=/);
    expect(res.headers["Set-Cookie"]).toMatch(/Secure/);
    expect(res.redirected).toBe("https://app.vercel.app");
  });

  it("redirects with access_denied when the code is missing", async () => {
    const res = mockRes();
    await callback({ query: { error: "access_denied" } }, res);
    expect(res.redirected).toBe("https://app.vercel.app?error=access_denied");
  });

  it("redirects with token_exchange_failed when the code exchange throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const res = mockRes();
    await callback({ query: { code: "bad" } }, res);
    expect(res.redirected).toBe(
      "https://app.vercel.app?error=token_exchange_failed",
    );
  });
});

describe("api/refresh", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("COOKIE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("VITE_SPOTIFY_CLIENT_ID", "id");
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "secret");
  });

  it("rejects non-POST requests with 405", async () => {
    const res = mockRes();
    await refresh({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "method_not_allowed" });
  });

  it("returns 401 no_session without a cookie", async () => {
    const res = mockRes();
    await refresh({ method: "POST", headers: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns an access token for a valid cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh", expires_in: 3600 }),
      }),
    );
    const sealed = sealToken("refresh-abc");
    const res = mockRes();
    await refresh({ method: "POST", headers: { cookie: `rt=${sealed}` } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ access_token: "fresh", expires_in: 3600 });
  });

  it("returns 401 refresh_failed for a tampered cookie", async () => {
    const res = mockRes();
    await refresh({ method: "POST", headers: { cookie: "rt=garbage" } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "refresh_failed" });
  });
});

describe("api/logout", () => {
  it("rejects non-POST requests with 405", async () => {
    const res = mockRes();
    await logout({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "method_not_allowed" });
  });

  it("clears the rt cookie with a Secure attribute and returns ok", async () => {
    const res = mockRes();
    await logout({ method: "POST" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["Set-Cookie"]).toMatch(/^rt=;/);
    expect(res.headers["Set-Cookie"]).toMatch(/Max-Age=0/);
    expect(res.headers["Set-Cookie"]).toMatch(/Secure/);
  });
});
