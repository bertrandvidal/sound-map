# Unknown-location artists in explore mode — design

**Date:** 2026-08-09
**Status:** approved

## Problem

Explore mode drops artists it cannot place. `ArtistClusterLayer` renders only
`status === "resolved"` artists, so an artist whose MusicBrainz/Nominatim
lookup came back empty (`status: "not_found"`) simply has no marker. The user
follows them, the resolution loop counted them as done, and they are nowhere
on the map — indistinguishable from an artist that was never fetched.

Now-playing already answers this: when `lookupArtistLocation` returns `null`,
`MapView` places the bubble at the Pacific fallback `(0, -160)` labelled
"Unknown location", and `LeafletMap` flies out to `UNKNOWN_ZOOM` so the empty
ocean reads as a deliberate nowhere rather than a broken map. Explore mode
should agree with it.

## Requirements

1. A followed artist with `status: "not_found"` gets a marker at the same
   Pacific placeholder used by now-playing, with the same "Unknown location"
   label.
2. The marker behaves like any other library marker: hover shows the artist
   name and place, click starts that artist's playback.
3. **The already-populated cache must work.** `geo:<artistId>` entries hold
   `{status: "not_found"}` with a 30-day TTL and there are many of them. The
   fix must light those artists up without a cache flush or key-version bump.
4. Backend failures must not be swept into the same bucket.

## Design

### One shared constant

`PACIFIC_FALLBACK` currently lives in `src/components/MapView.jsx`, private to
the now-playing path. Extract it to `src/unknownLocation.js` as
`UNKNOWN_LOCATION` and import it from both places, so the two views cannot
drift apart on coordinates or wording.

It does **not** go in `shared/geocode.js`. That module is imported by the
server (`api/geocode.js`), and "where do we draw a bubble when we don't know"
is a UI decision, not a geocoding one — `lookupArtistLocation` returning
`null` is the honest answer and must stay that way.

### The placeholder is applied at render, not in the hook

`useLibraryArtists` keeps reporting `not_found` verbatim. `ArtistClusterLayer`
gains a pure exported helper:

```js
export function mappableArtists(artists)
```

which selects the artists that get a marker and attaches the placeholder to
the unresolved ones:

- `resolved` → passed through untouched
- `not_found` → `{ ...artist, ...UNKNOWN_LOCATION }`
- `pending`, `unavailable`, anything else → excluded

The hook's contract is *what did resolution actually conclude*, and
`not_found` is a true conclusion. Writing coordinates into it there would make
every consumer see a fabricated location as fact. `ArtistClusterLayer` is
already the authority on which artists get a marker, so widening that decision
is a one-place change, and the helper is exported so it can be unit-tested the
way `zoomForLocation` is — this repo's component tests don't render
react-leaflet.

### Why `unavailable` and `pending` are excluded

`unavailable` means the `/api/geocode` call itself failed (Upstash outage,
network hop, non-200). That is "we don't have an answer yet", not "this artist
has no known origin". Mapping it to the Pacific would recreate exactly the bug
`failedCount` exists to prevent: an outage rendering as a confident, complete
answer. `pending` is simply not done yet — the loop is still walking the
queue, and `LibraryLoadingBadge` is the right place to show that.

### Why this makes the cache a non-issue

`/api/geocode` returns cached values verbatim, so a cached
`{status: "not_found", resolvedAt: <old>}` reaches the client as exactly the
same status a fresh lookup produces. Because the placeholder is applied on the
client, every one of those already-cached negatives renders in the Pacific on
the first load after deploy — no invalidation, no key-version bump, no
re-spending the MusicBrainz/Nominatim budget on artists we already know are
unresolvable.

A server-side rewrite (returning the fallback coordinates as a `resolved`
result) would have required rewriting or versioning those cache entries, and
would have put a UI placeholder into a cache shared with the metrics counters,
where `resolved` vs `notFound` is a measurement of upstream quality.

### No change to `ArtistMarker`

It already renders `📍 {artist.placeName}` and omits the line when there is no
place, so `UNKNOWN_LOCATION.placeName` flows into the tooltip for free.
Clicking still calls `onSelect` and starts playback via the existing path.

### Visual treatment

Unknown artists use the same 64px circular marker as resolved ones —
consistent with the now-playing bubble, which also does not change appearance
when the location is unknown. All of them share the exact same coordinate, so
`leaflet.markercluster` groups them into one themed cluster bubble and
spiderfies them into a ring at max zoom, with no new code. No deterministic
scatter/jitter: fabricating per-artist coordinates would make the placeholder
look like data.

**Accepted consequence:** a user whose followed artists are largely
unresolvable opens explore mode to a conspicuous cluster sitting in the
Pacific. That is the intended read, and it matches now-playing.

## Testing

Vitest, following the existing pure-function pattern:

- `mappableArtists` maps `not_found` to `(0, -160)` with
  `placeName: "Unknown location"` and `unknown: true`.
- `resolved` artists pass through with their own coordinates intact.
- `pending` and `unavailable` are excluded.
- A cached negative (`{status: "not_found", resolvedAt: <old timestamp>}`)
  still maps — the explicit guard for requirement 3.
- `MapView` still places the now-playing fallback at the same coordinates
  after the constant is extracted.

## Out of scope

- Changing what `LibraryLoadingBadge` counts.
- Retrying `not_found` artists against MusicBrainz.
- Any change to the geocode cache format, TTLs, or the server response shape.
