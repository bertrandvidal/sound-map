import { createSession } from "../server/auth.js";

export default async function handler(req, res) {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL;

  if (error || !code) {
    return res.redirect(`${frontendUrl}?error=access_denied`);
  }

  try {
    const { cookie } = await createSession(code, {
      clientId: process.env.VITE_SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.REDIRECT_URI,
      secure: true,
    });
    res.setHeader("Set-Cookie", cookie);
    return res.redirect(frontendUrl);
  } catch (err) {
    console.error("[api/callback] token exchange failed:", err);
    return res.redirect(`${frontendUrl}?error=token_exchange_failed`);
  }
}
