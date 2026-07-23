import "dotenv/config";
import { createApp } from "./app.js";

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const COOKIE_ENCRYPTION_KEY = process.env.COOKIE_ENCRYPTION_KEY;

if (!CLIENT_ID || !CLIENT_SECRET || !COOKIE_ENCRYPTION_KEY) {
  console.error(
    "Missing VITE_SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, or COOKIE_ENCRYPTION_KEY in .env",
  );
  process.exit(1);
}

const { app } = createApp({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
  frontendUrl: process.env.FRONTEND_URL,
  secure: false, // local dev is http on 127.0.0.1
});

app.listen(3000, "127.0.0.1", () => {
  console.log("[server] OAuth server listening on http://127.0.0.1:3000");
});
