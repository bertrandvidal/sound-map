import "dotenv/config";
import { createApp } from "./app.js";

const CLIENT_ID = process.env.VITE_SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing VITE_SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env",
  );
  process.exit(1);
}

const { app } = createApp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

app.listen(3000, "127.0.0.1", () => {
  console.log("[server] OAuth server listening on http://127.0.0.1:3000");
});
