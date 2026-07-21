import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshAccessToken } from "../auth.js";

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("returns the access token on HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "fresh-token", expires_in: 3600 }),
      }),
    );
    expect(await refreshAccessToken()).toBe("fresh-token");
  });

  it("throws SESSION_EXPIRED on HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(refreshAccessToken()).rejects.toThrow("SESSION_EXPIRED");
  });

  it("sends credentials so the session cookie is included", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ access_token: "t", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await refreshAccessToken();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
