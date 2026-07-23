import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { sealToken } from "../auth.js";

const CREDS = { clientId: "test-id", clientSecret: "test-secret" };

describe("createApp routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.COOKIE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("redirects to the frontend with access_denied when the callback errors", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://127.0.0.1:5173?error=access_denied",
    );
  });

  it("seals the refresh token into an httpOnly rt cookie and redirects with no token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?code=auth-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://127.0.0.1:5173");
    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/^rt=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i); // local is http
    expect(setCookie).not.toContain("refresh-abc");
  });

  it("redirects with token_exchange_failed when Spotify rejects the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?code=bad");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://127.0.0.1:5173?error=token_exchange_failed",
    );
  });

  it("returns 401 from /api/refresh when there is no cookie", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).post("/api/refresh");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns a fresh access token from /api/refresh for a valid cookie", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh-access", expires_in: 3600 }),
      }),
    );
    const { app } = createApp(CREDS);
    const sealed = sealToken("refresh-abc");
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", `rt=${sealed}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token: "fresh-access",
      expires_in: 3600,
    });
  });

  it("re-issues the rt cookie when Spotify rotates the refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "fresh-access",
            expires_in: 3600,
            refresh_token: "rotated",
          }),
      }),
    );
    const { app } = createApp(CREDS);
    const sealed = sealToken("refresh-abc");
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", `rt=${sealed}`);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toMatch(/^rt=/);
  });

  it("returns 401 refresh_failed when Spotify rejects the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const { app } = createApp(CREDS);
    const sealed = sealToken("refresh-abc");
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", `rt=${sealed}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "refresh_failed" });
  });

  it("clears the rt cookie and returns ok from /api/logout", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).post("/api/logout");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/^rt=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
  });
});
