# sound-map

Map the music you listen to — see where artists are from as album art bubbles on a world map, updated in real time as your Spotify listening changes.

## Prerequisites

- [Node.js](https://nodejs.org) (v18 or later)
- A Spotify account
- A Spotify Developer app ([create one here](https://developer.spotify.com/dashboard))

## Setup

1. **Create a Spotify Developer app**
   - Go to https://developer.spotify.com/dashboard
   - Click **Create app**
   - Under **Redirect URIs**, add: `http://127.0.0.1:3000/callback`
   - Save your **Client ID** and **Client Secret**

2. **Create a `.env` file** at the repo root (this file is gitignored):

   ```
   VITE_SPOTIFY_CLIENT_ID=your_client_id_here
   SPOTIFY_CLIENT_SECRET=your_client_secret_here
   ```

3. **Install dependencies**

   ```bash
   npm install
   ```

## Running locally

You need two terminal windows:

**Terminal 1 — OAuth server (port 3000):**
```bash
node server/index.js
```

**Terminal 2 — Frontend (port 5173):**
```bash
npm run dev
```

Or run both with one command:
```bash
npm start
```

Open http://localhost:5173, click **Login with Spotify**, and start playing something.

## Running tests

```bash
npm test
```
