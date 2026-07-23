# Vercel Operator Setup — Guided Runbook

**Companion to:** `docs/superpowers/plans/2026-07-23-vercel-deployment.md`
**Nature:** human-in-the-loop, click-through setup that cannot be expressed as
repo code. Work through it top to bottom, confirming each checkbox before moving
on. Nothing here is automated — an agent should read a step, wait for you to do
it, and confirm before continuing.

This is the last mile: the code (auth core, adapters, `vercel.json`, logout,
coverage gate) is already on the `vercel-deployment` branch. This runbook stands
up the Vercel project and Spotify config that the code expects.

## Prerequisites

- [ ] The `vercel-deployment` branch is merged to `main` (Vercel deploys
      production from `main`). Do this via the PR first.
- [ ] `git remote -v` shows the GitHub remote for this repo.

## A. Vercel account & project

- [ ] Create a Vercel account (hobby tier is enough) and log in.
- [ ] **Add New… → Project** → import the `sound-map` GitHub repo.
- [ ] Confirm the detected framework is **Vite**, build command `vite build`,
      output directory `dist`. **Do not deploy yet** — set the env vars first
      (section D), or the first deploy will boot without `COOKIE_ENCRYPTION_KEY`
      and every `/api/refresh` will 500.

## B. Vercel CLI + `vercel dev`

- [ ] Install the CLI: `npm i -g vercel` (or use `npx vercel`).
- [ ] `vercel login`, then `vercel link` inside the repo to connect this folder
      to the project.
- [ ] `vercel dev` runs the **production shape locally** — the static SPA plus
      the `api/` serverless functions on a single origin. This is worth doing
      because it exercises the Vercel adapters (`api/callback.js`,
      `api/refresh.js`, `api/logout.js`) that the plain `npm start` loop never
      touches. Sanity check: the SPA loads, and `POST /api/refresh` with no
      cookie returns `401 {"error":"no_session"}`.
      - Note: `vercel dev` reads env from the linked project (or a local
        `.env`); make sure `COOKIE_ENCRYPTION_KEY` is available to it too.

## C. Vercel MCP / agent integration (decision point)

- [ ] **Decide together:** Vercel offers an MCP server that lets an agent read
      deployments, build logs, and env vars from within the agent workflow. It
      is **optional** for this deploy — pure convenience for driving Vercel from
      chat rather than the dashboard. If you want it, add it per Vercel's MCP
      docs; otherwise skip and use the dashboard/CLI.

## D. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**, scoped to
the **Production** environment:

- [ ] `COOKIE_ENCRYPTION_KEY` — generate once with `openssl rand -base64 32`
      (must decode to exactly 32 bytes; the app throws a clear error otherwise).
- [ ] `VITE_SPOTIFY_CLIENT_ID` — your Spotify app's client ID (exposed to the
      browser; that's expected).
- [ ] `SPOTIFY_CLIENT_SECRET` — your Spotify app's client secret (server-only).
- [ ] `REDIRECT_URI=https://<app>.vercel.app/api/callback` — use the real app
      subdomain. If you don't know it before the first deploy, deploy once to
      learn it, then set this and redeploy.
- [ ] `FRONTEND_URL=https://<app>.vercel.app` — the app's own origin (the
      callback redirects here after setting the cookie).

## E. Spotify dashboard

- [ ] Add the production redirect URI
      `https://<app>.vercel.app/api/callback` **alongside** the existing
      `http://127.0.0.1:3000/callback` — keep both so local dev and production
      each work.
- [ ] Under **Users and Access**, add up to **5** allowlisted users (name +
      email each). This is the Development Mode cap; there is no public signup.

## F. Deploy & verify

- [ ] Trigger a production deploy (push/merge to `main`, or **Redeploy** in the
      Vercel dashboard).
- [ ] Visit `https://<app>.vercel.app`, log in with an allowlisted Spotify
      account, and confirm the map loads and a currently-playing track appears.
- [ ] In devtools → Application → Cookies, confirm the `rt` cookie is
      `HttpOnly`, `Secure`, `SameSite=Lax`.
- [ ] Click **Log out** (bottom-right) and confirm it returns to the landing
      page and clears the `rt` cookie.

## Preview-deployment behavior (know this going in)

PRs produce preview URLs with random subdomains. Spotify only honors
**exactly-registered** redirect URIs, and we register only production + local —
so **OAuth login completes only on production and local**, never on a preview
URL (this was an accepted design decision). Preview deployments are still useful
for inspecting UI changes; just don't expect to complete a Spotify login on one.
