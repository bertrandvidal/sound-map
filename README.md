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
   - Under **Redirect URIs**, add: `http://127.0.0.1:3000/api/callback`
   - Save your **Client ID** and **Client Secret**

2. **Create a `.env` file** at the repo root (this file is gitignored):

   ```bash
   cp .env.example .env
   ```

   Then fill in the values. `.env.example` documents each variable; you'll need
   your Spotify Client ID and Secret, a cookie key
   (`openssl rand -base64 32`), and the local callback/frontend URLs (already
   filled in for `vercel dev`).

3. **Install dependencies**

   ```bash
   npm install
   ```

## Running locally

Local dev runs the **same shape as production** — the static SPA plus the
`/api/*` serverless functions on a single origin — via the Vercel CLI:

```bash
npm i -g vercel      # once
vercel login         # once
vercel link          # once — link this folder to your Vercel project
npm start            # runs `vercel dev` on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000, click **Login with Spotify**, and start playing
something.

> `npm run dev` still runs the Vite frontend alone (port 5173) for quick UI-only
> work, but `/api/*` won't be available there — use `npm start` for anything that
> touches auth.

## Running tests

```bash
npm test
```
