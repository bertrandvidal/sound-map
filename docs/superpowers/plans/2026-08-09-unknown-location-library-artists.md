# Unknown-location library artists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show followed artists whose location lookup came back empty at the
same Pacific "Unknown location" placeholder that now-playing already uses,
including the ones already cached as `not_found`.

**Architecture:** Extract the now-playing Pacific fallback into a shared
constant (`src/unknownLocation.js`), then widen `ArtistClusterLayer`'s marker
selection through a new pure exported helper `mappableArtists(artists)` that
passes `resolved` artists through untouched and attaches the placeholder to
`not_found` ones. Nothing on the server or in the Redis cache changes — the
client re-interprets the `not_found` status it already receives, so the
30-day-cached negatives light up with no invalidation.

**Tech Stack:** Vite + React SPA, Vitest (`jsdom`), Biome, react-leaflet /
react-leaflet-cluster.

**Execution:** Dispatch a **Haiku** subagent per task. Every step below carries
its literal test body and implementation code, so execution here is
transcription plus running two commands — there is no design judgment left to
spend a larger model on. The reasoning was already paid for in brainstorming
and in writing this plan; running it inline on Opus buys nothing.

Escalate to Sonnet only if a task actually requires a decision the plan didn't
make. If a plan can't name a cheap executor, that's a signal the plan is
underspecified — fix the plan rather than the model.

Design doc: `docs/superpowers/specs/2026-08-09-unknown-location-library-artists-design.md`

## Global Constraints

- The placeholder is exactly `{ lat: 0, lng: -160, placeName: "Unknown location", unknown: true }` — identical to `MapView.jsx`'s current `PACIFIC_FALLBACK`.
- Only `resolved` and `not_found` artists get markers. `pending` and `unavailable` must stay off the map: `unavailable` is a backend/network failure, not a negative result.
- No change to `api/geocode.js`, `server/kv.js`, `shared/geocode.js`, the cache key format, TTLs, or the `/api/geocode` response shape.
- No change to what `LibraryLoadingBadge` counts.
- Component tests in this repo do **not** render react-leaflet — test exported pure functions, following `src/components/__tests__/LeafletMap.test.jsx`.
- Never commit to `main`; work on branch `unknown-location-library-artists`. Commit messages follow `~/.git-template.txt` (Why / How / Tests). The pre-commit hook runs `npx biome check . && npm test`; never bypass it with `--no-verify`.

## File Structure

- **Create** `src/unknownLocation.js` — the single definition of the
  "we don't know where this artist is from" map placeholder. One export, no
  dependencies, imported by both the now-playing path and explore mode. It is
  deliberately *not* in `shared/geocode.js`: that module is imported by the
  server, and this is a UI decision.
- **Create** `src/__tests__/unknownLocation.test.js` — pins the coordinates
  and the `unknown` flag other modules key off.
- **Modify** `src/components/MapView.jsx` — delete the local
  `PACIFIC_FALLBACK`, import `UNKNOWN_LOCATION` instead. Behavior identical.
- **Modify** `src/components/ArtistClusterLayer.jsx` — add and use the pure
  exported `mappableArtists(artists)`; the component keeps its single
  responsibility (turning a list of artists into a clustered marker layer),
  with the "which artists, and where" rule now testable in isolation.
- **Create** `src/components/__tests__/ArtistClusterLayer.test.jsx` — tests
  for `mappableArtists`, including the already-cached-negative case.

---

### Task 1: Shared unknown-location placeholder

**Files:**
- Create: `src/unknownLocation.js`
- Create: `src/__tests__/unknownLocation.test.js`
- Modify: `src/components/MapView.jsx` (the `PACIFIC_FALLBACK` const at ~line 16, and its use in `syncNowPlaying` at ~line 145)

**Interfaces:**
- Consumes: nothing.
- Produces: `export const UNKNOWN_LOCATION` — an object literal
  `{ lat: number, lng: number, placeName: string, unknown: boolean }`, frozen.
  Task 2 spreads it onto artist objects.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/unknownLocation.test.js`:

```js
import { describe, expect, it } from "vitest";
import { UNKNOWN_LOCATION } from "../unknownLocation.js";

describe("UNKNOWN_LOCATION", () => {
  it("sits in the empty Pacific, far from any real artist origin", () => {
    expect(UNKNOWN_LOCATION.lat).toBe(0);
    expect(UNKNOWN_LOCATION.lng).toBe(-160);
  });

  it("is labelled so a marker reads as a placeholder, not a place", () => {
    expect(UNKNOWN_LOCATION.placeName).toBe("Unknown location");
  });

  // LeafletMap.zoomForLocation keys its fly-out zoom off this flag; without
  // it the map frames empty ocean at ARTIST_ZOOM and reads as broken.
  it("carries the `unknown` flag consumers key their zoom off", () => {
    expect(UNKNOWN_LOCATION.unknown).toBe(true);
  });

  // Task 2 spreads this onto artist objects; a shared mutable literal would
  // let one consumer's edit leak into every other marker.
  it("cannot be mutated by a consumer", () => {
    expect(Object.isFrozen(UNKNOWN_LOCATION)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/unknownLocation.test.js`
Expected: FAIL — `Failed to resolve import "../unknownLocation.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/unknownLocation.js`:

```js
// Where a bubble goes when we have no idea where the artist is from: the
// empty mid-Pacific, far enough from any landmass that it can't be mistaken
// for a real origin. `unknown` marks it as the placeholder rather than a
// resolved location — LeafletMap.zoomForLocation keys its wide fly-out zoom
// off that flag (see UNKNOWN_ZOOM), because at ARTIST_ZOOM this spot is pure
// open water and reads as a broken map instead of as "we don't know".
//
// Shared by both views deliberately: now-playing (MapView, when
// lookupArtistLocation returns null) and explore mode (ArtistClusterLayer,
// for an artist the resolution loop marked not_found) must agree, or the
// same artist lands in two different places depending on how you got to it.
//
// Frozen because ArtistClusterLayer spreads it onto artist objects — a
// shared mutable literal would let one consumer's edit leak into every
// other marker.
export const UNKNOWN_LOCATION = Object.freeze({
  lat: 0,
  lng: -160,
  placeName: "Unknown location",
  unknown: true,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/unknownLocation.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Point MapView at the shared constant**

In `src/components/MapView.jsx`, delete the local declaration:

```js
// `unknown` marks this as the we-have-no-idea placeholder rather than a real
// resolved origin; LeafletMap keys its fly-to zoom off it (see UNKNOWN_ZOOM).
const PACIFIC_FALLBACK = {
  lat: 0,
  lng: -160,
  placeName: "Unknown location",
  unknown: true,
};
```

Add to the existing import block (alphabetical order among the `../` imports,
so after `../theme.js` and before `../useLibraryArtists.js`):

```js
import { UNKNOWN_LOCATION } from "../unknownLocation.js";
```

And in `syncNowPlaying`, change the one use:

```js
      if (mountedRef.current) setLocation(loc ?? UNKNOWN_LOCATION);
```

- [ ] **Step 6: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — in particular the existing `MapView` tests covering the
unknown-location fallback still pass, since the value is unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/unknownLocation.js src/__tests__/unknownLocation.test.js src/components/MapView.jsx
git commit
```

Message (Why / How / Tests per `~/.git-template.txt`):

```
Extract the unknown-location placeholder into one shared constant

Why:
Explore mode is about to need the same "we don't know where this artist
is from" map position that now-playing already uses, and the two views
must agree — the same artist landing in two different places depending
on how you got to them would read as a bug. The constant was private to
MapView.jsx, so sharing it meant either an import from a component or a
second copy that could drift.

How:
Moved PACIFIC_FALLBACK to src/unknownLocation.js as UNKNOWN_LOCATION and
pointed MapView at it. Frozen, because the next commit spreads it onto
artist objects and a shared mutable literal would let one consumer's edit
leak into every other marker. Deliberately not in shared/geocode.js: that
module is imported by the server, and where to draw a bubble when we don't
know is a UI decision, not a geocoding one.

Tests:
New src/__tests__/unknownLocation.test.js pins the coordinates, the label
and the `unknown` flag that LeafletMap.zoomForLocation keys its fly-out
zoom off. Full suite green — the value is unchanged, so MapView's existing
fallback coverage still passes.
```

---

### Task 2: Map `not_found` artists to the placeholder in explore mode

**Files:**
- Modify: `src/components/ArtistClusterLayer.jsx:21-34` (the `resolved` filter)
- Create: `src/components/__tests__/ArtistClusterLayer.test.jsx`

**Interfaces:**
- Consumes: `UNKNOWN_LOCATION` from Task 1 (`src/unknownLocation.js`).
- Produces: `export function mappableArtists(artists)` — takes the
  `libraryArtists` array from `useLibraryArtists` (objects shaped
  `{ id, name, imageUrl, status, lat?, lng?, placeName? }`, where `status` is
  one of `"pending" | "resolved" | "not_found" | "unavailable"`) or
  `null`/`undefined`, and returns a new array of artists that should get a
  marker, each carrying usable `lat`/`lng`. Nothing else depends on it.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/ArtistClusterLayer.test.jsx`:

```jsx
import { describe, expect, it } from "vitest";
import { UNKNOWN_LOCATION } from "../../unknownLocation.js";
import { mappableArtists } from "../ArtistClusterLayer.jsx";

const resolved = {
  id: "1",
  name: "Nirvana",
  status: "resolved",
  lat: 46.97,
  lng: -123.81,
  placeName: "Aberdeen, Washington",
};
const notFound = { id: "2", name: "Boris", status: "not_found" };

describe("mappableArtists", () => {
  it("keeps a resolved artist at its own location, untouched", () => {
    expect(mappableArtists([resolved])).toEqual([resolved]);
  });

  it("places a not_found artist at the shared unknown-location placeholder", () => {
    const [artist] = mappableArtists([notFound]);
    expect(artist.lat).toBe(UNKNOWN_LOCATION.lat);
    expect(artist.lng).toBe(UNKNOWN_LOCATION.lng);
    expect(artist.unknown).toBe(true);
  });

  // ArtistMarker renders `📍 {artist.placeName}` in its tooltip, so this is
  // what makes the marker read as a placeholder rather than a real place.
  it("labels a not_found artist so the tooltip explains itself", () => {
    expect(mappableArtists([notFound])[0].placeName).toBe("Unknown location");
  });

  it("keeps the artist's own identity when adding the placeholder", () => {
    const [artist] = mappableArtists([notFound]);
    expect(artist.id).toBe("2");
    expect(artist.name).toBe("Boris");
  });

  // The reason this fix lives on the client: geo:<artistId> entries cached
  // as not_found are returned verbatim by /api/geocode, so they reach us as
  // exactly this status and must map without any cache invalidation.
  it("maps a not_found result that came back from the geocode cache", () => {
    const cached = { ...notFound, status: "not_found", resolvedAt: 1 };
    expect(mappableArtists([cached])[0].lng).toBe(UNKNOWN_LOCATION.lng);
  });

  // An /api/geocode failure is "no answer yet", not "no known origin".
  // Mapping it would make an outage render as a confident, complete answer —
  // the exact bug failedCount exists to prevent.
  it("leaves an artist whose lookup failed off the map entirely", () => {
    expect(mappableArtists([{ id: "3", status: "unavailable" }])).toEqual([]);
  });

  it("leaves an artist still in the queue off the map", () => {
    expect(mappableArtists([{ id: "4", status: "pending" }])).toEqual([]);
  });

  it("does not mutate the artists it is given", () => {
    const input = { ...notFound };
    mappableArtists([input]);
    expect(input).toEqual(notFound);
  });

  it("handles a library that has not loaded yet", () => {
    expect(mappableArtists(undefined)).toEqual([]);
    expect(mappableArtists(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/ArtistClusterLayer.test.jsx`
Expected: FAIL — `mappableArtists is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/components/ArtistClusterLayer.jsx`, add the import:

```js
import { UNKNOWN_LOCATION } from "../unknownLocation.js";
```

Add the exported helper above the component:

```js
// Which artists get a marker, and where. Exported and pure so the rule is
// testable without rendering react-leaflet (same pattern as
// LeafletMap.zoomForLocation).
//
// A not_found artist gets the same Pacific placeholder the now-playing
// bubble uses. Dropping them, as this layer used to, made an artist the user
// actually follows indistinguishable from one that was never fetched.
//
// pending and unavailable stay off the map deliberately: "unavailable" is an
// /api/geocode failure (Upstash outage, network hop, non-200), which means
// "no answer yet", not "no known origin". Placing it would make an outage
// render as a confident, complete answer — the same bug useLibraryArtists'
// failedCount exists to prevent.
export function mappableArtists(artists) {
  return (artists ?? []).flatMap((artist) => {
    if (artist.status === "resolved") return [artist];
    if (artist.status === "not_found") return [{ ...artist, ...UNKNOWN_LOCATION }];
    return [];
  });
}
```

Use it in the component, replacing the `resolved` filter:

```js
export default function ArtistClusterLayer({ artists, onSelectArtist }) {
  const mappable = mappableArtists(artists);
  return (
    <MarkerClusterGroup iconCreateFunction={createClusterIcon}>
      {mappable.map((artist) => (
        <ArtistMarker
          key={artist.id}
          artist={artist}
          onSelect={onSelectArtist}
        />
      ))}
    </MarkerClusterGroup>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/ArtistClusterLayer.test.jsx`
Expected: PASS (9 tests).

- [ ] **Step 5: Run Biome and the full suite**

Run: `npx biome check . && npm test`
Expected: both clean. If Biome reports formatting (the `not_found` return line
above is long), run `npx biome check --write src/components/ArtistClusterLayer.jsx`.

- [ ] **Step 6: Commit**

```bash
git add src/components/ArtistClusterLayer.jsx src/components/__tests__/ArtistClusterLayer.test.jsx
git commit
```

Message:

```
Show unresolvable library artists at the unknown location

Why:
Explore mode rendered only artists with status "resolved", so an artist
whose MusicBrainz/Nominatim lookup came back empty had no marker at all —
someone the user actually follows was indistinguishable from one that was
never fetched. Now-playing already answers this case by putting the bubble
in the empty Pacific labelled "Unknown location"; the two views should
agree.

How:
ArtistClusterLayer now selects markers through a pure exported
mappableArtists(): resolved artists pass through untouched, not_found ones
get UNKNOWN_LOCATION spread onto them. The placeholder is applied here
rather than in useLibraryArtists so the hook keeps reporting what
resolution actually concluded, and rather than in api/geocode.js so the
30-day-cached not_found entries light up with no invalidation — the server
returns them verbatim, and the client is what reinterprets them.

pending and unavailable stay off the map: an /api/geocode failure means
"no answer yet", not "no known origin", and placing it would make an
outage render as a confident, complete answer.

ArtistMarker needed no change — it already renders artist.placeName in its
tooltip, so the marker explains itself, and clicking still starts playback.

Tests:
New src/components/__tests__/ArtistClusterLayer.test.jsx covers the
not_found mapping, resolved pass-through, exclusion of pending/unavailable,
non-mutation, an unloaded library, and explicitly a not_found result that
came back from the geocode cache. npx biome check . && npm test green.
```

---

### Task 3: Document the behavior and open the PR

**Files:**
- Modify: `CLAUDE.md` (the explore-mode paragraph in the "Data flow" section that describes `ArtistClusterLayer`)

**Interfaces:**
- Consumes: the behavior from Tasks 1 and 2.
- Produces: nothing code-facing.

- [ ] **Step 1: Update the architecture notes**

In `CLAUDE.md`, in the paragraph beginning "Explore mode overlays a second,
independent flow", after the sentence describing how `LeafletMap` swaps its
marker layer, add:

```markdown
`ArtistClusterLayer` maps both `resolved` and `not_found` artists: an artist
MusicBrainz/Nominatim could not place gets the shared `UNKNOWN_LOCATION`
placeholder (`src/unknownLocation.js`) that now-playing uses, so the two views
agree instead of explore mode silently dropping them. That reinterpretation is
deliberately client-side — `/api/geocode` returns cached `not_found` entries
verbatim, so already-cached negatives render without any invalidation.
`pending` and `unavailable` stay off the map: an `/api/geocode` failure is "no
answer yet", not "no known origin".
```

- [ ] **Step 2: Verify the docs claim is true**

Run: `npx biome check . && npm test`
Expected: PASS. (Evidence before assertions — the doc describes shipped,
tested behavior.)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit
```

Message:

```
Document explore mode's unknown-location markers

Why:
The rule for which artist statuses get a marker, and why the not_found
reinterpretation is client-side rather than in api/geocode.js, is a
decision a future reader would otherwise have to reconstruct from the
diff.

How:
Extended the explore-mode paragraph in CLAUDE.md's Data flow section.

Tests:
npx biome check . && npm test green — the note describes shipped, tested
behavior.
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin unknown-location-library-artists
gh pr create -R bertrandvidal/sound-map --base main \
  --title "Show unresolvable library artists at the unknown location" \
  --body "..."
```

`gh` needs the explicit `-R bertrandvidal/sound-map`: the git remote is an
`entire://` URL that `gh` cannot parse into a repo. The PR body should
summarize the problem, the client-side-vs-server-side decision, the cache
consequence (no invalidation needed), and link the design doc.

## Manual verification

After the PR is up, with `npm start` running and a Spotify session:

1. Open explore mode via **Browse Library** and let the badge finish.
2. Confirm a cluster bubble now sits in the mid-Pacific.
3. Click into it down to max zoom — the markers spiderfy into a ring.
4. Hover one: the tooltip shows the artist name and `📍 Unknown location`.
5. Click it: playback starts for that artist and the view stays in explore
   mode.

Because the cached negatives are reused, step 2 should appear on the *first*
load after deploy without waiting for a fresh resolution pass.
