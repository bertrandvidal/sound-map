# Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare white login screen with an immersive Spotify-dark landing page — a dot-matrix world map with album bubbles pinned at real cities, linked by a green route, behind a centered wordmark + randomized tagline + login button.

**Architecture:** Four new/renamed frontend modules composed by a renamed `LandingPage` component. A shared theme module removes duplicated palette constants. The world map is a self-contained decorative SVG (no Leaflet, no network). Tagline selection is pure client-side (no backend).

**Tech Stack:** React 18, Vite, inline styles (no global CSS), Vitest + jsdom + @testing-library/react.

## Global Constraints

- **No backend for taglines:** tagline pool is a static array in the bundle; selection is `Math.random` at mount. No fetch / server round-trip. Verbatim pool of 10 defined in Task 2.
- **Self-contained landing:** no external network calls, no map tiles, no Leaflet on the landing. All art is inline SVG.
- **Inline styles only:** match the codebase convention; no global CSS files or media queries (use `clamp()` for responsive sizing).
- **Button label:** exactly `Log in with Spotify`.
- **Palette:** `SURFACE #181818`, `SURFACE_ALT #282828`, `ACCENT #1DB954`, `TEXT #fff`, `MUTED #b3b3b3`, `STAGE #0a0a0a`.
- **Branch naming:** lowercase + digits + hyphens, no type prefix.
- **Commits:** follow `~/.git-template.txt` (Why / How / Tests). Pre-commit hook runs `npx biome check .` and `npm test` — both must pass. Never use `--no-verify`.
- **Tests:** Vitest, all HTTP mocked, `vi.restoreAllMocks()` in `beforeEach`.

---

### Task 1: Shared theme module + NowPlayingCard cleanup

**Files:**
- Create: `src/theme.js`
- Modify: `src/components/NowPlayingCard.jsx:4-8` (replace local palette constants with imports)

**Interfaces:**
- Produces: `src/theme.js` named exports `SURFACE`, `SURFACE_ALT`, `ACCENT`, `TEXT`, `MUTED`, `STAGE` (all string hex values).

- [ ] **Step 1: Create the theme module**

```js
// src/theme.js
// Spotify-like dark palette, shared across the map overlay and the landing page.
export const SURFACE = "#181818";
export const SURFACE_ALT = "#282828";
export const ACCENT = "#1DB954";
export const TEXT = "#fff";
export const MUTED = "#b3b3b3";
export const STAGE = "#0a0a0a"; // full-viewport landing background
```

- [ ] **Step 2: Point NowPlayingCard at the shared palette**

In `src/components/NowPlayingCard.jsx`, delete the five local constants (lines 3-8, the `// Spotify-like dark palette` block through `const MUTED = ...`) and add an import at the top:

```js
import { ACCENT, MUTED, SURFACE, SURFACE_ALT, TEXT } from "../theme.js";
```

Leave all usages (`SURFACE`, `ACCENT`, etc.) untouched — only their definition moves.

- [ ] **Step 3: Run the existing card tests to confirm no behavior change**

Run: `npx vitest run src/components/__tests__/NowPlayingCard.test.jsx`
Expected: PASS (all existing assertions still green — the palette values are identical).

- [ ] **Step 4: Lint**

Run: `npx biome check src/theme.js src/components/NowPlayingCard.jsx`
Expected: no errors. If import ordering is flagged, run `npx biome check --write` on both files.

- [ ] **Step 5: Commit**

```bash
git add src/theme.js src/components/NowPlayingCard.jsx
git commit -m "$(cat <<'MSG'
Extract shared Spotify-dark palette into theme.js

Why:
The palette hex values were hard-coded inside NowPlayingCard and about to be
duplicated by the new landing page. One source of truth avoids drift.

How:
Add src/theme.js exporting SURFACE/SURFACE_ALT/ACCENT/TEXT/MUTED plus a new
STAGE color for the landing background. NowPlayingCard now imports them.

Tests:
Existing NowPlayingCard tests pass unchanged (identical values).
MSG
)"
```

---

### Task 2: Tagline pool + client-side picker

**Files:**
- Create: `src/taglines.js`
- Test: `src/__tests__/taglines.test.js`

**Interfaces:**
- Produces: `TAGLINES` (array of 10 strings), `pickRandomTagline()` → one element of `TAGLINES`.

- [ ] **Step 1: Write the failing test**

```js
// src/__tests__/taglines.test.js
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAGLINES, pickRandomTagline } from "../taglines.js";

describe("taglines", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a pool of 10 taglines", () => {
    expect(TAGLINES).toHaveLength(10);
    for (const t of TAGLINES) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
    }
  });

  it("always returns a member of the pool", () => {
    expect(TAGLINES).toContain(pickRandomTagline());
  });

  it("uses Math.random to pick (first element at 0)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickRandomTagline()).toBe(TAGLINES[0]);
  });

  it("picks the last element as random approaches 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.9999);
    expect(pickRandomTagline()).toBe(TAGLINES[TAGLINES.length - 1]);
  });

  it("does not call fetch", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    pickRandomTagline();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/taglines.test.js`
Expected: FAIL — cannot resolve `../taglines.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/taglines.js
// Static pool baked into the bundle. Selection is pure client-side — never
// hits the backend, so the landing renders even if the API is down.
export const TAGLINES = [
  "See where your music comes from",
  "Every song has a hometown.",
  "Your listening, mapped across the world.",
  "Follow your music around the globe.",
  "A world tour, one track at a time.",
  "Where in the world is your playlist?",
  "Every artist starts somewhere.",
  "Your soundtrack has a map.",
  "From here to everywhere, one song at a time.",
  "Chart the origins of your sound.",
];

export function pickRandomTagline() {
  return TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/taglines.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/taglines.js src/__tests__/taglines.test.js
git commit -m "$(cat <<'MSG'
Add client-side tagline pool for the landing page

Why:
The landing should show a fresh tagline each load without depending on the
backend for copy.

How:
src/taglines.js exports a static 10-item TAGLINES array and pickRandomTagline()
which selects via Math.random. No fetch, no server round-trip.

Tests:
taglines.test.js covers pool size/shape, membership, deterministic selection
with Math.random stubbed, and that no fetch is issued.
MSG
)"
```

---

### Task 3: World map projection + decorative backdrop

**Files:**
- Create: `src/geoProject.js`
- Create: `src/worldMapPaths.js`
- Create: `src/components/WorldMapBackdrop.jsx`
- Test: `src/__tests__/geoProject.test.js`
- Test: `src/components/__tests__/WorldMapBackdrop.test.jsx`

**Interfaces:**
- Consumes: `ACCENT` from `src/theme.js`.
- Produces:
  - `src/geoProject.js`: `MAP_WIDTH` (1000), `MAP_HEIGHT` (500), `project(lat, lng)` → `{ x, y }`.
  - `src/worldMapPaths.js`: `WORLD_PATHS` (array of SVG path `d` strings, the continent silhouettes).
  - `src/components/WorldMapBackdrop.jsx`: default export `WorldMapBackdrop`, a presentational `aria-hidden` SVG. Renders exactly 5 bubbles (`<circle data-testid="bubble">`).

- [ ] **Step 1: Write the failing projection test**

```js
// src/__tests__/geoProject.test.js
import { describe, expect, it } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH, project } from "../geoProject.js";

describe("project (equirectangular)", () => {
  it("maps the origin to the map center", () => {
    expect(project(0, 0)).toEqual({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
  });

  it("maps the north-west corner to (0, 0)", () => {
    expect(project(90, -180)).toEqual({ x: 0, y: 0 });
  });

  it("maps the south-east corner to (MAP_WIDTH, MAP_HEIGHT)", () => {
    expect(project(-90, 180)).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/geoProject.test.js`
Expected: FAIL — cannot resolve `../geoProject.js`.

- [ ] **Step 3: Implement the projection helper**

```js
// src/geoProject.js
// Equirectangular projection into a fixed SVG coordinate space so bubble
// positions can be expressed as real lat/lng and drawn on the flat world art.
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;

export function project(lat, lng) {
  return {
    x: ((lng + 180) / 360) * MAP_WIDTH,
    y: ((90 - lat) / 180) * MAP_HEIGHT,
  };
}
```

- [ ] **Step 4: Run projection test to verify it passes**

Run: `npx vitest run src/__tests__/geoProject.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the continent path asset**

These are the validated simplified silhouettes from the design mockup. They are
deliberately low-detail — the dotted rendering is forgiving. (Optional future
upgrade: replace with a higher-fidelity public-domain simplified world map;
keep the same `WORLD_PATHS` export shape.)

```js
// src/worldMapPaths.js
// Simplified continent silhouettes in the 1000x500 equirectangular space of
// geoProject.js. Used only as a clip mask for the dot-matrix — decorative.
export const WORLD_PATHS = [
  "M110,100 L250,84 L320,120 L330,160 L295,175 L300,205 L255,205 L240,175 L215,225 L195,210 L188,165 L150,150 L118,124 Z",
  "M290,255 L335,258 L352,305 L338,368 L308,420 L288,392 L280,335 L295,300 Z",
  "M468,108 L512,98 L548,104 L566,130 L548,150 L560,168 L520,178 L500,166 L474,150 L470,128 Z",
  "M486,196 L556,188 L590,220 L582,262 L560,315 L522,372 L500,348 L500,300 L484,260 L480,222 Z",
  "M566,92 L700,76 L800,84 L866,120 L888,150 L842,178 L780,190 L700,178 L642,190 L600,178 L568,140 Z",
  "M778,318 L848,308 L892,338 L882,372 L830,388 L790,368 L772,340 Z",
];
```

- [ ] **Step 6: Write the failing backdrop test**

```jsx
// src/components/__tests__/WorldMapBackdrop.test.jsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WorldMapBackdrop from "../WorldMapBackdrop.jsx";

describe("WorldMapBackdrop", () => {
  it("renders five album bubbles", () => {
    const { container } = render(<WorldMapBackdrop />);
    expect(container.querySelectorAll('[data-testid="bubble"]')).toHaveLength(5);
  });

  it("is decorative (aria-hidden) so it is skipped by assistive tech", () => {
    const { container } = render(<WorldMapBackdrop />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
```

- [ ] **Step 7: Run backdrop test to verify it fails**

Run: `npx vitest run src/components/__tests__/WorldMapBackdrop.test.jsx`
Expected: FAIL — cannot resolve `../WorldMapBackdrop.jsx`.

- [ ] **Step 8: Implement the backdrop**

```jsx
// src/components/WorldMapBackdrop.jsx
import { MAP_HEIGHT, MAP_WIDTH, project } from "../geoProject.js";
import { ACCENT } from "../theme.js";
import { WORLD_PATHS } from "../worldMapPaths.js";

// Album bubbles pinned at real cities, in listening order (route connects them).
// Cities are illustrative choices for the decorative art, not user data.
const BUBBLES = [
  { lat: 47.6, lng: -122.3, r: 22, color: "#e35d5b" }, // Seattle
  { lat: -23.5, lng: -46.6, r: 20, color: "#b06ab3" }, // Sao Paulo
  { lat: 6.5, lng: 3.4, r: 20, color: "#f5c542" }, // Lagos (gold)
  { lat: 51.5, lng: -0.1, r: 26, color: "#3a7bd5" }, // London
  { lat: 35.7, lng: 139.7, r: 24, color: "#11998e" }, // Tokyo
];

const POINTS = BUBBLES.map((b) => ({ ...b, ...project(b.lat, b.lng) }));

// A gentle upward arc between two projected points.
function arc(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - 60;
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
}

export default function WorldMapBackdrop() {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      <defs>
        <pattern
          id="sm-dots"
          width="11"
          height="11"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" r="2" fill="#616161" />
        </pattern>
        <clipPath id="sm-land">
          {WORLD_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
      </defs>

      {/* subtle landmass fill so continents read against the near-black stage */}
      <rect
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        fill="#181818"
        clipPath="url(#sm-land)"
      />
      {/* bright dot-matrix, clipped to land */}
      <rect
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        fill="url(#sm-dots)"
        clipPath="url(#sm-land)"
      />

      {/* dashed green route threading the bubbles in order */}
      <g
        fill="none"
        stroke={ACCENT}
        strokeWidth="2.5"
        strokeDasharray="7 6"
        opacity="0.9"
      >
        {POINTS.slice(1).map((p, i) => (
          <path key={`${p.x}-${p.y}`} d={arc(POINTS[i], p)} />
        ))}
      </g>

      {/* soft shadows so bubbles feel anchored */}
      <g fill="#000" opacity="0.5">
        {POINTS.map((p) => (
          <ellipse
            key={`s-${p.x}-${p.y}`}
            cx={p.x}
            cy={p.y + p.r + 4}
            rx={p.r * 0.8}
            ry="5"
          />
        ))}
      </g>

      {/* the bubbles */}
      {POINTS.map((p) => (
        <circle
          key={`b-${p.x}-${p.y}`}
          data-testid="bubble"
          cx={p.x}
          cy={p.y}
          r={p.r}
          fill={p.color}
          stroke="#fff"
          strokeWidth="2.5"
        />
      ))}
    </svg>
  );
}
```

- [ ] **Step 9: Run backdrop + projection tests to verify they pass**

Run: `npx vitest run src/__tests__/geoProject.test.js src/components/__tests__/WorldMapBackdrop.test.jsx`
Expected: PASS (5 tests total).

- [ ] **Step 10: Lint**

Run: `npx biome check src/geoProject.js src/worldMapPaths.js src/components/WorldMapBackdrop.jsx src/__tests__/geoProject.test.js src/components/__tests__/WorldMapBackdrop.test.jsx`
Expected: no errors (run `--write` if formatting/import order is flagged).

- [ ] **Step 11: Commit**

```bash
git add src/geoProject.js src/worldMapPaths.js src/components/WorldMapBackdrop.jsx src/__tests__/geoProject.test.js src/components/__tests__/WorldMapBackdrop.test.jsx
git commit -m "$(cat <<'MSG'
Add decorative dot-matrix world map backdrop

Why:
The redesigned landing needs a self-contained world map that previews the app's
concept: album bubbles pinned at real places linked by a route.

How:
geoProject.js projects lat/lng into a 1000x500 SVG space. worldMapPaths.js holds
simplified continent silhouettes used as a clip mask for a dot pattern.
WorldMapBackdrop renders the dotted continents, a dashed green route, and five
bubbles. Pure inline SVG, aria-hidden, no network/Leaflet.

Tests:
geoProject.test.js checks corner/center projection. WorldMapBackdrop.test.jsx
asserts five bubbles render and the SVG is aria-hidden.
MSG
)"
```

---

### Task 4: LandingPage component + App wiring

**Files:**
- Create: `src/components/LandingPage.jsx`
- Delete: `src/components/LoginButton.jsx`
- Modify: `src/App.jsx:3` (import) and `src/App.jsx:64` (usage)
- Rename/rewrite test: delete `src/components/__tests__/LoginButton.test.jsx`, create `src/components/__tests__/LandingPage.test.jsx`
- Modify: `src/__tests__/App.test.jsx:12` (update mocked module path)

**Interfaces:**
- Consumes: `WorldMapBackdrop` (Task 3), `pickRandomTagline`/`TAGLINES` (Task 2), `ACCENT`/`TEXT`/`MUTED`/`STAGE` (Task 1), `buildAuthUrl` from `src/spotify.js`.
- Produces: `src/components/LandingPage.jsx` default export `LandingPage({ error })`. Same three error codes as before: `access_denied`, `token_exchange_failed`, `session_expired`.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/__tests__/LandingPage.test.jsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TAGLINES } from "../../taglines.js";
import LandingPage from "../LandingPage.jsx";

describe("LandingPage", () => {
  it("renders the wordmark", () => {
    render(<LandingPage error={null} />);
    expect(
      screen.getByRole("heading", { name: /sound-map/i }),
    ).toBeInTheDocument();
  });

  it("renders a tagline from the pool", () => {
    render(<LandingPage error={null} />);
    const found = TAGLINES.some((t) => screen.queryByText(t) !== null);
    expect(found).toBe(true);
  });

  it("renders a Spotify login link and button", () => {
    render(<LandingPage error={null} />);
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("accounts.spotify.com/authorize"),
    );
    expect(
      screen.getByRole("button", { name: /log in with spotify/i }),
    ).toBeInTheDocument();
  });

  it("shows the session-expired message", () => {
    render(<LandingPage error="session_expired" />);
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
  });

  it("shows the access-denied message", () => {
    render(<LandingPage error="access_denied" />);
    expect(screen.getByText(/access denied/i)).toBeInTheDocument();
  });

  it("shows the login-failed message on token exchange failure", () => {
    render(<LandingPage error="token_exchange_failed" />);
    expect(screen.getByText(/login failed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/LandingPage.test.jsx`
Expected: FAIL — cannot resolve `../LandingPage.jsx`.

- [ ] **Step 3: Implement LandingPage**

```jsx
// src/components/LandingPage.jsx
import { useMemo } from "react";
import { buildAuthUrl } from "../spotify.js";
import { pickRandomTagline } from "../taglines.js";
import { ACCENT, MUTED, STAGE, TEXT } from "../theme.js";
import WorldMapBackdrop from "./WorldMapBackdrop.jsx";

const ERROR_MESSAGES = {
  access_denied: { text: "Access denied. Please try again.", color: "#f15e6c" },
  token_exchange_failed: {
    text: "Login failed. Please try again.",
    color: "#f15e6c",
  },
  session_expired: {
    text: "Session expired (1 hour limit). Please log in again.",
    color: "#f5c542",
  },
};

export default function LandingPage({ error }) {
  // Pick once per page load, not on every render. Pure client-side.
  const tagline = useMemo(() => pickRandomTagline(), []);
  const err = ERROR_MESSAGES[error];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: STAGE,
        overflow: "hidden",
        fontFamily: "sans-serif",
      }}
    >
      <WorldMapBackdrop />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
        }}
      >
        {/* radial scrim keeps the centered content legible over the art */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse 60% 55% at 50% 45%, rgba(0,0,0,0.85), rgba(0,0,0,0) 70%)",
            pointerEvents: "none",
          }}
        />

        <h1
          style={{
            position: "relative",
            color: TEXT,
            fontSize: "clamp(40px, 9vw, 64px)",
            fontWeight: 800,
            letterSpacing: "-2px",
            margin: 0,
          }}
        >
          sound-map
        </h1>

        <p
          style={{
            position: "relative",
            color: MUTED,
            fontSize: "clamp(14px, 3.5vw, 18px)",
            marginTop: 12,
          }}
        >
          {tagline}
        </p>

        {err && (
          <p
            style={{
              position: "relative",
              color: err.color,
              fontSize: "clamp(13px, 3vw, 15px)",
              marginTop: 12,
            }}
          >
            {err.text}
          </p>
        )}

        <a
          href={buildAuthUrl()}
          style={{
            position: "relative",
            textDecoration: "none",
            marginTop: 28,
          }}
        >
          <button
            type="button"
            style={{
              background: ACCENT,
              color: "#000",
              fontWeight: 700,
              fontSize: "clamp(14px, 3.5vw, 16px)",
              padding: "14px 32px",
              border: "none",
              borderRadius: 999,
              cursor: "pointer",
              boxShadow: "0 6px 24px rgba(29,185,84,0.3)",
            }}
          >
            Log in with Spotify
          </button>
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/LandingPage.test.jsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire App to LandingPage and remove the old component**

In `src/App.jsx`, change line 3 from:

```js
import LoginButton from "./components/LoginButton.jsx";
```
to:
```js
import LandingPage from "./components/LandingPage.jsx";
```

and line 64 from:

```js
  return <LoginButton error={error} />;
```
to:
```js
  return <LandingPage error={error} />;
```

Then delete the obsolete files:

```bash
git rm src/components/LoginButton.jsx src/components/__tests__/LoginButton.test.jsx
```

- [ ] **Step 6: Update the App test's mocked module path**

In `src/__tests__/App.test.jsx`, change line 12 from:

```js
vi.mock("../components/LoginButton.jsx", () => ({
```
to:
```js
vi.mock("../components/LandingPage.jsx", () => ({
```

(The mock body — `default: ({ error }) => <div data-testid="login">{error ?? "login"}</div>` — stays the same.)

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites green (App, LandingPage, WorldMapBackdrop, taglines, geoProject, NowPlayingCard, MapView, and the existing geo/auth/spotify/pollError suites). No lingering reference to `LoginButton`.

- [ ] **Step 8: Lint the whole tree**

Run: `npx biome check .`
Expected: no errors (run `npx biome check --write .` if formatting/import order is flagged, then re-run).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'MSG'
Redesign landing page as immersive Spotify-dark world map

Why:
The login screen was a bare white page out of step with the app's dark map UI.
The new landing previews the concept and matches the Spotify look.

How:
Rename LoginButton to LandingPage: a fixed dark stage with the WorldMapBackdrop
behind a centered wordmark, a randomized client-side tagline, error messages,
and the green "Log in with Spotify" pill on a radial scrim. Wire App.jsx to it,
remove LoginButton, and update the App test's mocked module path.

Tests:
LandingPage.test.jsx covers the wordmark, a pool tagline, the login link/button,
and all three error messages. Full suite and biome pass.
MSG
)"
```

---

## Notes for the executor

- After all tasks: run `npm start` and eyeball the landing at `http://localhost:5173` (desktop + a narrow viewport) to confirm the map, route, bubbles, scrim, and button look right and nothing overflows horizontally. This is a manual visual check, not a test gate.
- The branch was created as `worktree-landing-page-redesign`. Before opening the PR, push to a clean branch name `landing-page-redesign` (no `worktree-` prefix) to satisfy the naming convention.
