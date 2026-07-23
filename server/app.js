import express from "express";
import {
  COOKIE_NAME,
  clearSessionCookie,
  createSession,
  parseCookies,
  refreshSession,
} from "./auth.js";

export function createApp({
  clientId,
  clientSecret,
  redirectUri = "http://127.0.0.1:3000/callback",
  frontendUrl = "http://127.0.0.1:5173",
  secure = false,
}) {
  const app = express();

  app.get("/callback", async (req, res) => {
    const { code, error } = req.query;
    console.info("[server] OAuth callback received");

    if (error || !code) {
      return res.redirect(`${frontendUrl}?error=access_denied`);
    }

    try {
      const { cookie } = await createSession(code, {
        clientId,
        clientSecret,
        redirectUri,
        secure,
      });
      res.setHeader("Set-Cookie", cookie);
      // No token in the URL — the SPA fetches one via POST /api/refresh.
      return res.redirect(frontendUrl);
    } catch (err) {
      console.error("[server] token exchange failed:", err);
      return res.redirect(`${frontendUrl}?error=token_exchange_failed`);
    }
  });

  app.post("/api/refresh", async (req, res) => {
    const sealed = parseCookies(req.headers.cookie)[COOKIE_NAME];
    console.info("[server] token refresh requested");
    if (!sealed) {
      return res.status(401).json({ error: "no_session" });
    }

    try {
      const { accessToken, expiresIn, cookie } = await refreshSession(sealed, {
        clientId,
        clientSecret,
        secure,
      });
      if (cookie) res.setHeader("Set-Cookie", cookie); // persist rotation
      console.info("[server] token refresh succeeded");
      res.json({ access_token: accessToken, expires_in: expiresIn });
    } catch (err) {
      console.error("[server] token refresh failed:", err);
      res.status(401).json({ error: "refresh_failed" });
    }
  });

  app.post("/api/logout", (_req, res) => {
    console.info("[server] logout requested");
    res.setHeader("Set-Cookie", clearSessionCookie({ secure }));
    res.status(200).json({ ok: true });
  });

  return { app };
}
