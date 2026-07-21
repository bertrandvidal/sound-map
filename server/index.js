import { randomUUID } from "node:crypto";
import "dotenv/config";
import express from "express";
import { exchangeRefreshToken, parseCookies } from "./auth.js";

const app = express();

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = "http://127.0.0.1:3000/callback";
const FRONTEND_URL = "http://127.0.0.1:5173";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing VITE_SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env",
  );
  process.exit(1);
}

// sessionId -> { refreshToken }. In-memory: a server restart clears sessions
// (re-login), which is acceptable for local dev. Swap for a real store later.
const sessions = new Map();

app.get("/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`${FRONTEND_URL}?error=access_denied`);
  }

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
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
    console.error("Token exchange network error:", err);
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
  }

  if (!tokenResponse.ok) {
    console.error(
      "Token exchange failed:",
      tokenResponse.status,
      await tokenResponse.text(),
    );
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
    console.error("Failed to parse token response:", err);
    return res.redirect(`${FRONTEND_URL}?error=token_exchange_failed`);
  }

  const sessionId = randomUUID();
  sessions.set(sessionId, { refreshToken });

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
  if (!session) {
    return res.status(401).json({ error: "no_session" });
  }

  try {
    const { accessToken, expiresIn, refreshToken } = await exchangeRefreshToken(
      session.refreshToken,
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    );
    session.refreshToken = refreshToken; // persist Spotify rotation
    res.json({ access_token: accessToken, expires_in: expiresIn });
  } catch (err) {
    console.error("Refresh failed:", err.message);
    sessions.delete(sid);
    res.status(401).json({ error: "refresh_failed" });
  }
});

app.listen(3000, "127.0.0.1", () => {
  console.log("OAuth server listening on http://127.0.0.1:3000");
});
