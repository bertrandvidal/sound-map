# Landing Page Redesign — Design Spec

**Date:** 2026-07-23
**Status:** Approved (design), pending spec review

## Goal

Replace the bare white login screen (`src/components/LoginButton.jsx` — a centered
`<h1>` and an unstyled button) with an immersive, branded landing page that matches
the Spotify-dark look and feel the app already uses on the map screen
(`NowPlayingCard.jsx`).

The landing art *is* the app's core concept: a simplified world map with a few
album bubbles pinned at real places, linked by a route — like a playlist carrying
you from one place to the next.

## Visual Direction (validated via visual companion)

- Full-viewport dark stage (`#0a0a0a`).
- **Dot-matrix world map**: continents drawn as a field of bright dots over a
  subtle landmass fill so they read clearly against the background. Dots are
  rendered by clipping a dot `<pattern>` to a bundled simplified world-map path.
- **Five album bubbles** pinned at real cities, each a gradient-filled circle with
  a white ring and a soft drop shadow so it feels anchored to its spot.
- **Green route** (`#1DB954`, dashed) threading the bubbles in listening order:
  North America → South America → Africa → Europe → Asia.
- **Centered content** on a soft radial scrim for legibility: `sound-map`
  wordmark, a randomized tagline, and a green "Log in with Spotify" pill.
- **Static** — no motion.

Bubble anchors (lat/lng → projected to SVG space):

| Order | City         | Region        | lat/lng          | Color     |
|-------|--------------|---------------|------------------|-----------|
| 1     | Seattle      | North America | 47.6, -122.3     | `#e35d5b` |
| 2     | São Paulo    | South America | -23.5, -46.6     | `#b06ab3` |
| 3     | Lagos        | Africa        | 6.5, 3.4         | `#f5c542` (gold) |
| 4     | London       | Europe        | 51.5, -0.1       | `#3a7bd5` |
| 5     | Tokyo        | Asia          | 35.7, 139.7      | `#11998e` |

(Cities are illustrative choices for the decorative art, not derived from user data.)

## Taglines

Randomized **once per page load**, chosen client-side. **No backend involvement:**
the taglines are a static array baked into the frontend bundle and selection is
pure client-side JavaScript (`Math.random` over the array at mount via `useMemo`).
The landing page's text renders even if `server/index.js` / the API is completely
down. This is an explicit constraint — tagline selection must never trigger a
fetch or any server round-trip.

Pool (10):

1. See where your music comes from
2. Every song has a hometown.
3. Your listening, mapped across the world.
4. Follow your music around the globe.
5. A world tour, one track at a time.
6. Where in the world is your playlist?
7. Every artist starts somewhere.
8. Your soundtrack has a map.
9. From here to everywhere, one song at a time.
10. Chart the origins of your sound.

Button label: **"Log in with Spotify"**.

## Architecture / Components

Staying with the codebase's inline-style convention (no global CSS).

### `src/theme.js` (new)

Extract the Spotify-dark palette currently hard-coded inside `NowPlayingCard.jsx`
(`SURFACE #181818`, `SURFACE_ALT #282828`, `ACCENT #1DB954`, `TEXT #fff`,
`MUTED #b3b3b3`) into a single shared module. One source of truth instead of
duplicated hex codes.

### `src/taglines.js` (new)

- `TAGLINES` — the array of 10 strings above.
- `pickRandomTagline()` — returns a random member of `TAGLINES`. Isolated so it is
  trivially unit-testable and so the "no backend" property is obvious in one place.

### `src/components/WorldMapBackdrop.jsx` (new)

Purely presentational decorative SVG. `aria-hidden` (decoration, not content).

- Dot-matrix continents: a dot `<pattern>` clipped (`clipPath`) to a bundled
  simplified world-map silhouette path, over a subtle landmass fill.
- The dashed green route and the five bubbles (with drop shadows).
- Bubble positions defined as **lat/lng** constants, projected to the SVG's
  coordinate space via a small equirectangular helper
  (`x = (lng+180)/360*W`, `y = (90-lat)/180*H`). Route arcs are quadratic curves
  between projected points with a raised control point.
- Takes no data props (the art is fixed); may accept optional style/size props.

### `src/components/LandingPage.jsx` (renamed from `LoginButton.jsx`)

Composes the page. Renamed because it is now a full page, not a button.

- Renders `<WorldMapBackdrop />` full-bleed behind the content.
- Centered flex column overlay on a soft radial scrim: wordmark (`<h1>`), the
  randomized tagline (`<p>`, chosen via `useMemo(() => pickRandomTagline(), [])`),
  the three error messages, and the login button.
- Same `error` prop and same three error states as today:
  `access_denied`, `token_exchange_failed`, `session_expired`.
- Login control is a real `<a href={buildAuthUrl()}>` wrapping a `<button>`.

### `src/App.jsx` (edit)

Update the import and usage: `LoginButton` → `LandingPage`. The `error` prop is
unchanged. No other logic changes.

### `NowPlayingCard.jsx` (edit — small, related cleanup)

Replace its local palette constants with imports from `src/theme.js`. Removes the
duplication introduced by extracting the shared theme. Behavior unchanged.

## Asset

One asset to source: a permissively-licensed **simplified** world-map SVG
(continent silhouettes) bundled into the repo. The dot-matrix renders by clipping a
dot pattern to those paths — the same technique proven in the mockups, with an
accurate outline instead of rough placeholder blobs. No external/network map tiles;
the landing must be fully self-contained (Leaflet is intentionally NOT used here).

## Layout / Responsive

- SVG backdrop full-bleed with `preserveAspectRatio` set so the whole map + route
  stay visible (letterboxed by the background color on odd aspect ratios) — never
  crop a bubble.
- Content is a centered flex column. Font sizes use `clamp()` so the wordmark and
  tagline scale down on mobile without external CSS / media queries (keeps the
  inline-style convention intact).
- Always dark theme; no light-mode handling needed.

## Accessibility

- `WorldMapBackdrop` is `aria-hidden` (decorative).
- Wordmark is an `<h1>`; login is a real focusable `<a>`/`<button>`.
- Radial scrim guarantees text/background contrast over the art.
- Static art — no `prefers-reduced-motion` concern.

## Testing (Vitest + jsdom, all HTTP mocked)

- **`taglines`**: `pickRandomTagline()` always returns a member of `TAGLINES`;
  with `Math.random` stubbed, it returns the expected entry. Assert `TAGLINES`
  has 10 entries.
- **`LandingPage`**: renders the wordmark; renders a tagline that is a member of
  the pool; the login button points at `buildAuthUrl()`; each of the three error
  codes renders its message. No fetch is called during render (guards the
  "no backend" constraint).
- **`WorldMapBackdrop`**: renders five bubbles and is `aria-hidden`.

## Out of Scope

- The main map screen (`MapView`, `LeafletMap`) is unchanged.
- No changes to auth, polling, or `server/index.js`.
- Real album art on the landing (unavailable pre-login; bubbles are decorative).
