import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const CREDS = { clientId: "test-id", clientSecret: "test-secret" };

describe("createApp routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("redirects to the frontend with access_denied when the callback errors", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).get("/callback?error=access_denied");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "http://127.0.0.1:5173?error=access_denied",
    );
  });

  it("stores a session, sets an httpOnly sid cookie, and redirects with no token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ refresh_token: "refresh-abc" }),
      }),
    );
    const { app, sessions } = createApp(CREDS);
    const res = await request(app).get("/callback?code=auth-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://127.0.0.1:5173");
    const setCookie = res.headers["set-cookie"][0];
    expect(setCookie).toMatch(/^sid=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(sessions.size).toBe(1);
  });

  it("returns 401 from /api/refresh when there is no session cookie", async () => {
    const { app } = createApp(CREDS);
    const res = await request(app).post("/api/refresh");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "no_session" });
  });

  it("returns a fresh access token from /api/refresh for a valid session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh-access", expires_in: 3600 }),
      }),
    );
    const { app, sessions } = createApp(CREDS);
    sessions.set("sid-1", { refreshToken: "refresh-abc" });
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", "sid=sid-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token: "fresh-access",
      expires_in: 3600,
    });
  });

  it("evicts the session and returns 401 when Spotify rejects the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );
    const { app, sessions } = createApp(CREDS);
    sessions.set("sid-1", { refreshToken: "refresh-abc" });
    const res = await request(app)
      .post("/api/refresh")
      .set("Cookie", "sid=sid-1");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "refresh_failed" });
    expect(sessions.has("sid-1")).toBe(false);
  });
});
