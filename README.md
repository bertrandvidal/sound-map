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
> touches auth or the explore-mode geocoding endpoint (`/api/geocode`).

## Running tests

```bash
npm test
```

## Deploying to Vercel

The app deploys as a Vercel project: the static SPA build plus the `/api/*`
serverless functions, backed by an Upstash Redis instance that explore mode
uses as a geocode cache and rate limiter. This section sets that project up
from scratch.

1. **Install the CLI and log in** (skip if you already did this for
   [Running locally](#running-locally)):

   ```bash
   npm i -g vercel
   vercel login
   ```

2. **Link the repo to a Vercel project**

   ```bash
   vercel link
   ```

   Linking writes a `.vercel/project.json` (gitignored) that records which
   Vercel project this local folder talks to — it's how `vercel dev`,
   `vercel env`, `vercel deploy`, etc. know where to read config and
   environment variables from. `vercel link` walks you through creating a
   new project or picking an existing one.

   For deploys triggered by `git push` rather than run by hand, also (or
   instead) import the repo from the Vercel dashboard: **Add New → Project →
   Import Git Repository**. Once imported, pushes to any branch produce a
   preview deployment, and pushes to the production branch (`main` here)
   produce a production deployment — see step 6.

3. **Register the production redirect URI with Spotify**

   The Spotify app from local [Setup](#setup) only has the local redirect URI
   registered. Go back to it on the
   [Spotify dashboard](https://developer.spotify.com/dashboard) and add the
   production callback under **Redirect URIs** too, e.g.
   `https://<your-project>.vercel.app/api/callback`. Spotify matches redirect
   URIs exactly, so it has to be the literal URL your deployment serves
   `/api/callback` from.

4. **Set environment variables**

   `.env.example` documents each one; set these by hand per environment
   (Preview / Production) in **Project → Settings → Environment Variables**
   in the dashboard, or with `vercel env add <NAME> <environment>`:

   - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` — same Spotify app as
     local, from the Spotify dashboard
   - `COOKIE_ENCRYPTION_KEY` — generate a separate one for production
     (`openssl rand -base64 32`); don't reuse the local dev key
   - `REDIRECT_URI` — the production callback URL from step 3
   - `FRONTEND_URL` — the production origin (same as `REDIRECT_URI` minus
     `/api/callback`)
   - `GEOCODE_MIN_INTERVAL_MS` — copy the value from `.env.example`

   > `REDIRECT_URI` is read as a single static value at request time
   > (`api/login.js`, `api/callback.js`) — it can't vary per request. Vercel
   > Preview deployments each get their own fresh, random URL, so a
   > `REDIRECT_URI` set once for the Preview environment will only ever
   > match *one specific* preview deployment (or a fixed preview alias, if
   > you've set one up in the Vercel dashboard). Clicking Login against any
   > other preview URL hits Spotify's `INVALID_CLIENT: Invalid redirect URI`
   > dead end. Test the login flow against the production domain, or pin a
   > stable alias and register that exact URL with Spotify instead — see
   > step 6.

   `VERCEL_OIDC_TOKEN` and the Redis variables (next step) are auto-injected
   by integrations — don't set those by hand. Once everything above is set,
   pull it all into a local `.env.local` with:

   ```bash
   vercel env pull --environment=production
   ```

   The `--environment` flag matters: `vercel env pull` on its own defaults
   to the **Development** environment, not Preview or Production, so it
   silently pulls the wrong values (or nothing, if you never set any
   Development ones) instead of what you just configured above.

5. **Provision Upstash Redis for explore mode**

   From the dashboard's **Storage** tab, add the **Upstash for Redis**
   integration (or `vercel integration add upstash/upstash-kv` — run
   `vercel integration discover upstash` to confirm the slug) and connect a
   database to this project.

   The integration injects Redis credentials into the project's environment
   variables under a **`REDIS_`** prefix: `REDIS_KV_REST_API_URL`,
   `REDIS_KV_REST_API_TOKEN`, plus `REDIS_KV_REST_API_READ_ONLY_TOKEN`,
   `REDIS_KV_URL`, `REDIS_URL`. That's why `server/kv.js` constructs the
   `Redis` client explicitly from `REDIS_KV_REST_API_URL` /
   `REDIS_KV_REST_API_TOKEN` instead of calling `Redis.fromEnv()` —
   `fromEnv()` only recognizes `KV_REST_API_*` or `UPSTASH_REDIS_REST_*`
   pairs, and this integration sets neither.

   > The exact names can depend on how the integration is connected (which
   > product, project- vs. account-level). Don't assume the names above —
   > after connecting, run `vercel env ls` and check what actually landed
   > against what `server/kv.js` reads.

6. **Deploy**

   ```bash
   vercel          # preview deployment, own URL, doesn't touch production
   vercel --prod   # production deployment, promotes to the project's domain
   ```

   If the repo was imported via the dashboard (step 2), pushes do this for
   you automatically — any branch push makes a preview deployment, a push to
   the production branch makes a production deployment. `vercel` /
   `vercel --prod` are for deploying from your machine without waiting on a
   push.

   > Login only works against whichever exact URL `REDIRECT_URI` is set to
   > (see the callout in step 4) — a bare `vercel` preview deployment gets a
   > brand-new URL each time, so clicking Login there will not work out of
   > the box. Use `vercel --prod`, or a fixed preview alias registered with
   > Spotify, to actually exercise auth end to end.
