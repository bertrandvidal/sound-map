import { COOKIE_NAME, parseCookies, refreshSession } from "../server/auth.js";

export default async function handler(req, res) {
  const sealed = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!sealed) {
    return res.status(401).json({ error: "no_session" });
  }

  try {
    const { accessToken, expiresIn, cookie } = await refreshSession(sealed, {
      clientId: process.env.VITE_SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      secure: true,
    });
    if (cookie) res.setHeader("Set-Cookie", cookie); // persist rotation
    return res.status(200).json({
      access_token: accessToken,
      expires_in: expiresIn,
    });
  } catch (err) {
    console.error("[api/refresh] refresh failed:", err);
    return res.status(401).json({ error: "refresh_failed" });
  }
}
