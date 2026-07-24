import {
  clearStateCookie,
  createSession,
  parseCookies,
  STATE_COOKIE_NAME,
} from "../server/auth.js";

export default async function handler(req, res) {
  const { code, error, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL;

  if (error || !code) {
    return res.redirect(`${frontendUrl}?error=access_denied`);
  }

  // CSRF check: the state Spotify echoes back must match the one-time value
  // /api/login minted into the oauth_state cookie before this browser left.
  const expectedState = parseCookies(req.headers.cookie)[STATE_COOKIE_NAME];
  if (!state || !expectedState || state !== expectedState) {
    console.error("[api/callback] OAuth state mismatch");
    return res.redirect(`${frontendUrl}?error=state_mismatch`);
  }

  try {
    const { cookie } = await createSession(code, {
      clientId: process.env.VITE_SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.REDIRECT_URI,
      secure: true,
    });
    res.setHeader("Set-Cookie", [cookie, clearStateCookie({ secure: true })]);
    return res.redirect(frontendUrl);
  } catch (err) {
    console.error("[api/callback] token exchange failed:", err);
    return res.redirect(`${frontendUrl}?error=token_exchange_failed`);
  }
}
