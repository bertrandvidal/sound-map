import { randomUUID } from "node:crypto";
import express from "express";
import { exchangeRefreshToken, parseCookies } from "./auth.js";

const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const FRONTEND_URL = "http://127.0.0.1:5173";

export function createApp({ clientId, clientSecret }) {
  const app = express();

  // sessionId -> { refreshToken }. In-memory: a server restart clears sessions
  // (re-login), which is acceptable for local dev. Swap for a real store later.
  const sessions = new Map();

  app.get("/callback", async (req, res) => {
    const { code, error } = req.query;
    console.info("[server] OAuth callback received");

    if (error || !code) {
      return res.redirect(`${FRONTEND_URL}?error=access_denied`);
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );

    let tokenResponse;
    try {
      tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });
    } catch (err) {
      console.error("[server] token exchange network error:", err.message);
      return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
    }

    if (!tokenResponse.ok) {
      console.error("[server] token exchange failed:", tokenResponse.status);
      return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
    }

    let refreshToken;
    try {
      const body = await tokenResponse.json();
      refreshToken = body.refresh_token;
      if (!refreshToken) {
        return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
      }
    } catch (err) {
      console.error("[server] failed to parse token response:", err.message);
      return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
    }

    const sessionId = randomUUID();
    sessions.set(sessionId, { refreshToken });
    console.info(`[server] session created (${sessions.size} active)`);

    res.cookie("sid", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // http on localhost/127.0.0.1
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    // No token in the URL — the SPA fetches one via POST /api/refresh.
    res.redirect(FRONTEND_URL);
  });

  app.post("/api/refresh", async (req, res) => {
    const { sid } = parseCookies(req.headers.cookie);
    const session = sid ? sessions.get(sid) : undefined;
    console.info("[server] token refresh requested");
    if (!session) {
      return res.status(401).json({ error: "no_session" });
    }

    try {
      const { accessToken, expiresIn, refreshToken } =
        await exchangeRefreshToken(session.refreshToken, {
          clientId,
          clientSecret,
        });
      session.refreshToken = refreshToken; // persist Spotify rotation
      console.info("[server] token refresh succeeded");
      res.json({ access_token: accessToken, expires_in: expiresIn });
    } catch (err) {
      console.error(
        "[server] token refresh failed, session evicted:",
        err.message,
      );
      sessions.delete(sid);
      res.status(401).json({ error: "refresh_failed" });
    }
  });

  return { app, sessions };
}
