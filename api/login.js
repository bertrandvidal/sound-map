import { randomUUID } from "node:crypto";
import { buildAuthorizeUrl, buildStateCookie } from "../server/auth.js";

export default function handler(_req, res) {
  const state = randomUUID();
  res.setHeader("Set-Cookie", buildStateCookie(state, { secure: true }));
  return res.redirect(
    buildAuthorizeUrl({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      redirectUri: process.env.REDIRECT_URI,
      state,
    }),
  );
}
