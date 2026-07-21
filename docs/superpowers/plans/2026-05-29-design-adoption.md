# Design Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the dark, branded look from the root prototype (`Sound Map.html` + `sound-map-app.jsx`, `sound-map-components.jsx`, `tweaks-panel.jsx`) into the real Vite/React/Leaflet app, then get the prototype out of the lint/build path.

**Architecture:** Keep the real Leaflet map but switch its tile layer to **CartoDB Dark Matter** (the palette the prototype's fake SVG map was explicitly mimicking — see the `#15171e`/`#1e2030` comments in `sound-map-components.jsx`). Port five presentational pieces as inline-styled React components (matching the existing code's convention — the current `src/` already uses inline styles, no CSS framework): a global dark theme + font, a branded login screen, a top bar, a **display-only** "Now Playing" bar, and a redesigned album pin with pulse rings. CSS `@keyframes` live in one imported stylesheet.

**Tech Stack:** React 18, react-leaflet 4.2, Leaflet 1.9, Vite 8, Vitest + jsdom, `@testing-library/react` (added in Task 4), inline styles.

---

## Design decisions (flagged for the author — please confirm during review)

1. **The "Now Playing" bar is display-only.** The prototype's player bar has play/pause/skip/shuffle/volume controls. The real app only holds the `user-read-currently-playing` scope, which is **read-only** — it cannot control playback. Wiring those buttons would require the `user-modify-playback-state` scope *and* the Spotify Web Playback SDK (a much larger feature). Showing dead buttons is misleading UX, so this plan ports the bar as a now-playing **display**: album art, track name, artist, location, and a "Live" indicator. The transport controls are intentionally omitted. *If you'd rather keep them as non-functional visual elements, say so in review.*

2. **The TopBar shows the brand wordmark + a "Log out" button.** The prototype's profile pill shows a display name and avatar. That needs a `GET /me` call (extra round-trip, and `display_name` availability varies). Deferred to keep this plan scoped to *look*, not *new data*. The brand wordmark + logout is the useful 80%.

3. **The prototype's `MapBackground` (a hand-drawn SVG world map) is discarded.** The real app has a genuine Leaflet map; we only borrow the prototype's *color palette* by switching tile layers. We do not port the fake SVG continents.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `docs/design-prototype/` | Frozen reference copy of the 4 root prototype files | Create (move) |
| `biome.json` | Exclude the prototype folder from lint/format | Modify |
| `index.html` | Add Figtree font `<link>`s | Modify |
| `src/styles.css` | Global dark theme + `@keyframes` (pulseRing, fadeIn, slideUp, fadeInScale) | Create |
| `src/main.jsx` | Import `styles.css` | Modify |
| `src/components/icons.jsx` | `GlobeIcon`, `PinIcon` (only the icons the real app uses) | Create |
| `src/components/LoginButton.jsx` | Becomes the branded dark login screen | Modify (rewrite) |
| `src/components/NowPlayingBar.jsx` | Display-only bottom bar | Create |
| `src/components/TopBar.jsx` | Brand wordmark + Log out | Create |
| `src/components/AlbumBubble.jsx` | Redesigned pin; icon HTML extracted to a pure helper | Modify |
| `src/album-icon.js` | `buildAlbumIcon({ imageUrl, placeName })` pure helper | Create |
| `src/components/LeafletMap.jsx` | Dark tile layer | Modify |
| `src/components/MapView.jsx` | Render TopBar + NowPlayingBar overlays + styled idle/error/loading | Modify |
| `src/App.jsx` | Thread an `onLogout` handler down to MapView | Modify |
| `src/__tests__/icons.test.jsx` | Icon renders | Create |
| `src/__tests__/LoginButton.test.jsx` | Login screen renders + error states | Create |
| `src/__tests__/NowPlayingBar.test.jsx` | Bar renders track/artist/location | Create |
| `src/__tests__/TopBar.test.jsx` | Brand + logout callback | Create |
| `src/__tests__/album-icon.test.js` | Helper embeds image URL + place name | Create |

---

### Task 1: Get the prototype out of the lint/build path

The four root files (`Sound Map.html`, `sound-map-app.jsx`, `sound-map-components.jsx`, `tweaks-panel.jsx`) are not gitignored, so once committed, the pre-commit hook's `npx biome check .` will lint them and **fail** — they use browser globals (`window.useTweaks`, global `React`) and JSX in non-module scripts. Move them into `docs/design-prototype/` (kept as a runnable reference — the `<script src="...">` tags are relative, so moving all four together keeps `Sound Map.html` working) and tell Biome to ignore that folder.

**Files:**
- Create: `docs/design-prototype/` (move 4 files into it)
- Modify: `biome.json`

- [ ] **Step 1: Move the four prototype files**

```bash
mkdir -p docs/design-prototype
git mv "Sound Map.html" docs/design-prototype/ 2>/dev/null || mv "Sound Map.html" docs/design-prototype/
mv sound-map-app.jsx sound-map-components.jsx tweaks-panel.jsx docs/design-prototype/
ls docs/design-prototype/
```
Expected: the four files listed under `docs/design-prototype/`.

- [ ] **Step 2: Exclude the folder from Biome**

In `biome.json`, change the `files` block from:

```json
  "files": {
    "ignoreUnknown": false
  },
```
to:

```json
  "files": {
    "ignoreUnknown": false,
    "includes": ["**", "!docs/design-prototype/**"]
  },
```

- [ ] **Step 3: Verify Biome passes on the working tree**

Run: `npx biome check .`
Expected: no errors (no complaints about the prototype `.jsx` files).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: freeze UI prototype under docs/design-prototype

Why: the prototype .jsx files use browser globals and would fail
biome lint once committed; they are a design reference, not build code.
How: moved all four files together (relative script tags still resolve)
and excluded the folder in biome.json.
Tests: npx biome check . passes."
```

---

### Task 2: Global dark theme + Figtree font

**Files:**
- Create: `src/styles.css`
- Modify: `src/main.jsx`, `index.html`

- [ ] **Step 1: Create `src/styles.css`**

```css
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html,
body,
#root {
  height: 100%;
  width: 100%;
}

body {
  background: #0c0f18;
  color: #fff;
  font-family: "Figtree", system-ui, sans-serif;
  overflow: hidden;
}

@keyframes pulseRing {
  0% {
    transform: translate(-50%, -50%) scale(0.55);
    opacity: 0.75;
  }
  100% {
    transform: translate(-50%, -50%) scale(1.9);
    opacity: 0;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fadeInScale {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.75);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}
```

- [ ] **Step 2: Import the stylesheet in `src/main.jsx`**

Add the import after the existing imports:

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
```

- [ ] **Step 3: Add the Figtree font to `index.html`**

Replace the `<head>` contents so it includes the font links:

```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>sound-map</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
  </head>
```

- [ ] **Step 4: Verify the build still works**

Run: `npm run build`
Expected: build succeeds, no CSS errors.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css src/main.jsx index.html
git commit -m "feat: add dark theme base styles and Figtree font

Why: foundation for adopting the prototype's visual language.
How: src/styles.css holds globals + keyframes, imported in main.jsx;
font linked in index.html.
Tests: npm run build succeeds."
```

---

### Task 3: Add `@testing-library/react` and confirm the existing suite still runs

This dependency is used by Tasks 4–8. (Plan 3 also needs it; whichever plan runs first installs it.)

**Files:** Modify `package.json` (via npm)

- [ ] **Step 1: Install**

```bash
npm install -D @testing-library/react@^16 @testing-library/jest-dom@^6
```

- [ ] **Step 2: Verify the existing tests still pass**

Run: `npm test`
Expected: the existing `geo` and `spotify` suites pass; no new tests yet.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @testing-library/react for component tests

Why: upcoming presentational components need render tests.
How: dev-dependency install.
Tests: npm test still green."
```

---

### Task 4: Branded login screen

Rewrite `LoginButton.jsx` (keep the filename + default export + `error` prop so `App.jsx` is unchanged) as the dark branded screen ported from the prototype's `LoginScreen`. It keeps the real `buildAuthUrl()` anchor.

**Files:**
- Modify: `src/components/LoginButton.jsx`
- Create: `src/__tests__/LoginButton.test.jsx`
- Depends on: `src/components/icons.jsx` (created here)

- [ ] **Step 1: Create `src/components/icons.jsx`**

```jsx
export function GlobeIcon({ size = 24 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function PinIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
    </svg>
  );
}
```

- [ ] **Step 2: Write the failing test `src/__tests__/LoginButton.test.jsx`**

```jsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LoginButton from "../components/LoginButton.jsx";

describe("LoginButton", () => {
  it("renders a Spotify sign-in link pointing at the authorize URL", () => {
    render(<LoginButton error={null} />);
    const link = screen.getByRole("link", { name: /sign in with spotify/i });
    expect(link.getAttribute("href")).toContain("accounts.spotify.com/authorize");
  });

  it("shows an access-denied message", () => {
    render(<LoginButton error="access_denied" />);
    expect(screen.getByText(/access denied/i)).toBeTruthy();
  });

  it("shows a session-expired message", () => {
    render(<LoginButton error="session_expired" />);
    expect(screen.getByText(/session expired/i)).toBeTruthy();
  });

  it("shows a token-exchange-failed message", () => {
    render(<LoginButton error="token_exchange_failed" />);
    expect(screen.getByText(/login failed/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/LoginButton.test.jsx`
Expected: FAIL (current `LoginButton` markup uses a `<button>` text "Login with Spotify", not a link named "Sign in with Spotify").

- [ ] **Step 4: Rewrite `src/components/LoginButton.jsx`**

```jsx
import { buildAuthUrl } from "../spotify.js";
import { GlobeIcon } from "./icons.jsx";

const ERROR_MESSAGES = {
  access_denied: { color: "#ff6b6b", text: "Access denied. Please try again." },
  token_exchange_failed: { color: "#ff6b6b", text: "Login failed. Please try again." },
  session_expired: { color: "#ffa94d", text: "Session expired (1-hour limit). Log in again." },
};

export default function LoginButton({ error }) {
  const message = ERROR_MESSAGES[error];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0d0d0d",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        animation: "fadeIn 0.5s ease",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "radial-gradient(circle, #252535 1px, transparent 1px)",
          backgroundSize: "30px 30px",
          opacity: 0.45,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, transparent 35%, #0d0d0d 78%)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
          maxWidth: 320,
          width: "100%",
          padding: "0 28px",
          animation: "slideUp 0.5s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: "50%",
              background: "#1DB954",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <GlobeIcon size={22} />
          </div>
          <span style={{ fontSize: 27, fontWeight: 800, letterSpacing: "-0.03em" }}>sound-map</span>
        </div>

        <p style={{ fontSize: 14, color: "#888", textAlign: "center", lineHeight: 1.65, margin: "0 0 6px" }}>
          Map your music — see where your artists come from, updated in real time.
        </p>

        {message && (
          <p style={{ color: message.color, fontSize: 13, textAlign: "center", margin: 0 }}>{message.text}</p>
        )}

        <a href={buildAuthUrl()} style={{ width: "100%", textDecoration: "none" }}>
          <span
            style={{
              display: "flex",
              width: "100%",
              padding: "15px 24px",
              background: "#1DB954",
              borderRadius: 40,
              color: "#000",
              fontSize: 15,
              fontWeight: 700,
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            Sign in with Spotify
          </span>
        </a>

        <p style={{ fontSize: 11, color: "#3e3e3e", textAlign: "center", lineHeight: 1.7, margin: "4px 0 0" }}>
          Requires a Spotify account. Only reads currently-playing track.
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/LoginButton.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/icons.jsx src/components/LoginButton.jsx src/__tests__/LoginButton.test.jsx
git commit -m "feat: branded dark login screen

Why: adopt the prototype's login visual language.
How: rewrote LoginButton as the dark screen with brand mark and styled
error states; added shared GlobeIcon/PinIcon.
Tests: src/__tests__/LoginButton.test.jsx (4 cases)."
```

---

### Task 5: Display-only "Now Playing" bar

**Files:**
- Create: `src/components/NowPlayingBar.jsx`, `src/__tests__/NowPlayingBar.test.jsx`

- [ ] **Step 1: Write the failing test `src/__tests__/NowPlayingBar.test.jsx`**

```jsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import NowPlayingBar from "../components/NowPlayingBar.jsx";

const track = {
  trackName: "Stronger Than Us",
  artistName: "HashFinger",
  albumImageUrl: "https://example.com/art.jpg",
};

describe("NowPlayingBar", () => {
  it("renders the track and artist names", () => {
    render(<NowPlayingBar track={track} location={{ placeName: "London" }} />);
    expect(screen.getByText("Stronger Than Us")).toBeTruthy();
    expect(screen.getByText("HashFinger")).toBeTruthy();
  });

  it("renders the location name and a Live indicator", () => {
    render(<NowPlayingBar track={track} location={{ placeName: "London" }} />);
    expect(screen.getByText("London")).toBeTruthy();
    expect(screen.getByText(/live/i)).toBeTruthy();
  });

  it("renders nothing when there is no track", () => {
    const { container } = render(<NowPlayingBar track={null} location={null} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/NowPlayingBar.test.jsx`
Expected: FAIL with "Failed to resolve import ../components/NowPlayingBar.jsx".

- [ ] **Step 3: Create `src/components/NowPlayingBar.jsx`**

```jsx
import { PinIcon } from "./icons.jsx";

export default function NowPlayingBar({ track, location }) {
  if (!track) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: 84,
        background: "rgba(12,14,20,0.97)",
        backdropFilter: "blur(24px)",
        borderTop: "1px solid rgba(255,255,255,0.07)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 14,
        animation: "slideUp 0.4s ease",
      }}
    >
      {track.albumImageUrl ? (
        <img
          src={track.albumImageUrl}
          alt=""
          style={{ width: 54, height: 54, borderRadius: 6, boxShadow: "0 2px 12px rgba(0,0,0,0.65)" }}
        />
      ) : (
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 6,
            background: "#1e3448",
            boxShadow: "0 2px 12px rgba(0,0,0,0.65)",
          }}
        />
      )}

      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#fff",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {track.trackName}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#b3b3b3",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {track.artistName}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#888", fontSize: 12 }}>
        <PinIcon size={13} />
        <span>{location?.placeName ?? "Locating…"}</span>
        <div
          style={{
            marginLeft: 8,
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#1DB954",
            boxShadow: "0 0 6px #1DB954",
          }}
        />
        <span style={{ color: "#1DB954", fontWeight: 600 }}>Live</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/NowPlayingBar.test.jsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/NowPlayingBar.jsx src/__tests__/NowPlayingBar.test.jsx
git commit -m "feat: display-only Now Playing bar

Why: surface current track + resolved location with the prototype's look.
How: NowPlayingBar shows album art, track/artist, location and a Live dot;
transport controls intentionally omitted (read-only scope).
Tests: src/__tests__/NowPlayingBar.test.jsx (3 cases)."
```

---

### Task 6: TopBar (brand + Log out)

**Files:**
- Create: `src/components/TopBar.jsx`, `src/__tests__/TopBar.test.jsx`

- [ ] **Step 1: Write the failing test `src/__tests__/TopBar.test.jsx`**

```jsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TopBar from "../components/TopBar.jsx";

describe("TopBar", () => {
  it("renders the brand wordmark", () => {
    render(<TopBar onLogout={() => {}} />);
    expect(screen.getByText("sound-map")).toBeTruthy();
  });

  it("calls onLogout when the log out button is clicked", () => {
    const onLogout = vi.fn();
    render(<TopBar onLogout={onLogout} />);
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/TopBar.test.jsx`
Expected: FAIL with "Failed to resolve import ../components/TopBar.jsx".

- [ ] **Step 3: Create `src/components/TopBar.jsx`**

```jsx
import { GlobeIcon } from "./icons.jsx";

export default function TopBar({ onLogout }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 58,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 20px",
        background: "linear-gradient(to bottom, rgba(10,12,20,0.88) 0%, transparent 100%)",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "#fff",
          fontWeight: 700,
          fontSize: 15,
          letterSpacing: "-0.02em",
          pointerEvents: "auto",
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "#1DB954",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <GlobeIcon size={14} />
        </div>
        sound-map
      </div>

      <button
        type="button"
        onClick={onLogout}
        style={{
          padding: "6px 14px",
          borderRadius: 24,
          background: "rgba(0,0,0,0.52)",
          backdropFilter: "blur(12px)",
          border: "1px solid rgba(255,255,255,0.09)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          pointerEvents: "auto",
          fontFamily: "inherit",
        }}
      >
        Log out
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/TopBar.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/TopBar.jsx src/__tests__/TopBar.test.jsx
git commit -m "feat: top bar with brand and log out

Why: persistent brand + a way to clear the session.
How: TopBar renders the wordmark and a Log out button calling onLogout.
Tests: src/__tests__/TopBar.test.jsx (2 cases)."
```

---

### Task 7: Redesigned album pin (extract icon builder to a pure helper)

`AlbumBubble` returns a react-leaflet `<Marker>`, which can only render inside a `<MapContainer>` — so it can't be unit-tested in isolation. Extract the `L.divIcon` HTML construction into a pure function `buildAlbumIcon` and test that.

**Files:**
- Create: `src/album-icon.js`, `src/__tests__/album-icon.test.js`
- Modify: `src/components/AlbumBubble.jsx`

- [ ] **Step 1: Write the failing test `src/__tests__/album-icon.test.js`**

```js
import L from "leaflet";
import { describe, expect, it } from "vitest";
import { buildAlbumIcon } from "../album-icon.js";

describe("buildAlbumIcon", () => {
  it("returns a Leaflet divIcon", () => {
    const icon = buildAlbumIcon({ imageUrl: "https://x/a.jpg", placeName: "London" });
    expect(icon).toBeInstanceOf(L.DivIcon);
  });

  it("embeds the album image URL in the icon HTML", () => {
    const icon = buildAlbumIcon({ imageUrl: "https://x/a.jpg", placeName: "London" });
    expect(icon.options.html).toContain("https://x/a.jpg");
  });

  it("embeds the place name in the icon HTML", () => {
    const icon = buildAlbumIcon({ imageUrl: "https://x/a.jpg", placeName: "London" });
    expect(icon.options.html).toContain("London");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/album-icon.test.js`
Expected: FAIL with "Failed to resolve import ../album-icon.js".

- [ ] **Step 3: Create `src/album-icon.js`**

```js
import L from "leaflet";

// Escape a string for safe interpolation into the divIcon HTML attribute/text.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildAlbumIcon({ imageUrl, placeName }) {
  const safeUrl = escapeHtml(imageUrl);
  const safePlace = escapeHtml(placeName);

  const html = `
    <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);animation:fadeInScale 0.5s cubic-bezier(.34,1.56,.64,1)">
      <div style="position:absolute;top:50%;left:50%;width:120px;height:120px;border-radius:50%;border:1.5px solid #1DB954;pointer-events:none;animation:pulseRing 2.6s ease-out infinite"></div>
      <div style="position:absolute;top:50%;left:50%;width:88px;height:88px;border-radius:50%;border:1.5px solid #1DB954;pointer-events:none;animation:pulseRing 2.6s ease-out 0.9s infinite"></div>
      <img src="${safeUrl}" alt="" style="width:62px;height:62px;border-radius:50%;border:2.5px solid rgba(255,255,255,0.88);box-shadow:0 4px 22px rgba(0,0,0,0.7),0 0 0 3px rgba(29,185,84,0.22);object-fit:cover;display:block" />
      <div style="position:absolute;top:calc(100% + 12px);left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(0,0,0,0.72);color:rgba(255,255,255,0.9);font-size:11px;font-weight:500;padding:4px 11px;border-radius:20px;font-family:'Figtree',sans-serif;border:1px solid rgba(255,255,255,0.08)">${safePlace}</div>
    </div>`;

  return L.divIcon({
    html,
    className: "",
    iconSize: [62, 62],
    iconAnchor: [31, 31],
    popupAnchor: [0, -36],
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/album-icon.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewrite `src/components/AlbumBubble.jsx` to use the helper**

```jsx
import { useMemo } from "react";
import { Marker, Popup } from "react-leaflet";
import { buildAlbumIcon } from "../album-icon.js";

export default function AlbumBubble({ location, imageUrl, trackName, artistName }) {
  const icon = useMemo(
    () => buildAlbumIcon({ imageUrl, placeName: location?.placeName }),
    [imageUrl, location?.placeName],
  );

  if (!location?.lat || !location?.lng) return null;

  return (
    <Marker position={[location.lat, location.lng]} icon={icon}>
      <Popup>
        <strong>{artistName}</strong>
        <br />
        {trackName}
        <br />
        <em>{location.placeName}</em>
      </Popup>
    </Marker>
  );
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/album-icon.js src/__tests__/album-icon.test.js src/components/AlbumBubble.jsx
git commit -m "feat: redesigned album pin with pulse rings and location pill

Why: match the prototype's animated artist pin.
How: extracted buildAlbumIcon (pure, testable) and consumed it in AlbumBubble.
Tests: src/__tests__/album-icon.test.js (3 cases)."
```

---

### Task 8: Dark tile layer

**Files:** Modify `src/components/LeafletMap.jsx`

- [ ] **Step 1: Swap the `<TileLayer>` to CartoDB Dark Matter**

In `src/components/LeafletMap.jsx`, replace the `<TileLayer .../>` element with:

```jsx
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        subdomains="abcd"
        maxZoom={20}
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
      />
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/components/LeafletMap.jsx
git commit -m "feat: dark map tiles (CartoDB Dark Matter)

Why: the prototype's palette was mimicking Dark Matter; use the real thing.
How: switched TileLayer URL + attribution to CARTO dark_all.
Tests: npm run build succeeds."
```

---

### Task 9: Wire TopBar + NowPlayingBar into MapView and add logout

**Files:**
- Modify: `src/components/MapView.jsx`, `src/App.jsx`

- [ ] **Step 1: Add an `onLogout` handler in `src/App.jsx`**

In `App.jsx`, change the `MapView` usage so it receives `onLogout`:

```jsx
  if (token) {
    return (
      <MapView
        token={token}
        onSessionExpired={() => {
          setToken(null);
          setError("session_expired");
        }}
        onLogout={() => {
          setToken(null);
          setError(null);
        }}
      />
    );
  }
```

- [ ] **Step 2: Render the overlays + dark states in `src/components/MapView.jsx`**

Update the imports and the render section. Add `import TopBar from "./TopBar.jsx";` and `import NowPlayingBar from "./NowPlayingBar.jsx";`, accept `onLogout` in the props, and replace the three `return` blocks (idle / error / playing) with overlay-based versions:

```jsx
export default function MapView({ token, onSessionExpired, onLogout }) {
  // ... existing state + polling effect unchanged ...

  const centeredOverlay = (text, color = "#888") => (
    <div
      style={{
        position: "fixed",
        bottom: 108,
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(0,0,0,0.62)",
        backdropFilter: "blur(16px)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        padding: "12px 22px",
        color,
        fontSize: 13,
        fontWeight: 500,
        zIndex: 50,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <LeafletMap track={track} location={location} />
      <TopBar onLogout={onLogout} />
      {status === "idle" && centeredOverlay("Play something on Spotify to see it on the map")}
      {status === "error" && centeredOverlay("Something went wrong. Check the console.", "#ff6b6b")}
      {status === "playing" && <NowPlayingBar track={track} location={location} />}
    </div>
  );
}
```

(The `loading` status renders just the map + top bar, which is correct — nothing to show yet.)

- [ ] **Step 3: Verify the full suite + build**

Run: `npm test && npm run build`
Expected: all tests pass; build succeeds.

- [ ] **Step 4: Manually verify the look**

Run: `npm start`, open `http://localhost:5173`, log in, play a track. Confirm: dark map, branded login, top bar with Log out, now-playing bar with location + Live, animated album pin. (See `docs/run` or the project `/run` skill if present.)

- [ ] **Step 5: Commit**

```bash
git add src/components/MapView.jsx src/App.jsx
git commit -m "feat: compose dark UI — map + top bar + now-playing overlay

Why: assemble the ported components into the live experience.
How: MapView renders LeafletMap with TopBar/NowPlayingBar overlays and
dark idle/error pills; App threads an onLogout handler.
Tests: npm test green; npm run build succeeds; manual smoke test done."
```

---

### Task 10: Update docs

**Files:** Modify `README.md`, `CLAUDE.md`

- [ ] **Step 1: Note the design source in `README.md`**

Add a short "Design" section pointing at `docs/design-prototype/` as the visual reference.

- [ ] **Step 2: Update the `CLAUDE.md` architecture section**

Update the `LeafletMap.jsx` / `AlbumBubble` description to mention the dark tiles, the extracted `src/album-icon.js`, and the new `TopBar` / `NowPlayingBar` overlays.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: record design prototype source and updated component map

Why: keep README/CLAUDE.md in step with the new UI.
How: documented docs/design-prototype/ and the new component structure.
Tests: n/a (docs)."
```

---

## Self-Review

- **Spec coverage:** login screen (T4), now-playing bar (T5), top bar (T6), album pin (T7), dark tiles (T8), theme/font (T2), prototype removed from lint path (T1), wiring (T9), docs (T10). All prototype-derived visuals except the deliberately-dropped transport controls and SVG map (documented in Design Decisions). ✅
- **Placeholders:** none — every component has full code. ✅
- **Type consistency:** `buildAlbumIcon({ imageUrl, placeName })` defined in T7 and consumed identically in `AlbumBubble`; `onLogout` prop defined in `App` (T9) → `MapView` (T9) → `TopBar` (T6). `track`/`location` shapes match `fetchCurrentlyPlaying`/`lookupArtistLocation` outputs already in the codebase. ✅
