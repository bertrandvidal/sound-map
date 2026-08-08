const USER_AGENT = "sound-map/0.1 (https://github.com/bertrandvidal/sound-map)";
const MB_BASE = "https://musicbrainz.org/ws/2";
const NOM_BASE = "https://nominatim.openstreetmap.org";

// MusicBrainz hands us a bare area *name* ("Aberdeen"), and Nominatim ranks a
// free-text search by "importance" — so "Aberdeen" resolves to Aberdeen,
// Scotland, and Nirvana ends up in the North Sea instead of Washington state.
// The two helpers below narrow the search with the structure MusicBrainz
// already knows about: the artist's country, and the area's parent area.

/**
 * The artist's origin area: `begin-area` (usually a city) when MusicBrainz has
 * it, otherwise `area` (usually the country).
 */
export function selectArea(artist) {
  return artist?.["begin-area"] ?? artist?.area ?? null;
}

/**
 * ISO 3166-1 alpha-2 code for Nominatim's `countrycodes` filter, lowercased.
 * `artist.country` is the reliable source on a search result; the area's own
 * iso codes are only present when the area *is* a country.
 */
export function countryCodeFor(artist, area) {
  const code = artist?.country ?? area?.["iso-3166-1-codes"]?.[0];
  return code ? code.toLowerCase() : null;
}

/**
 * The containing area from an `inc=area-rels` area lookup. MusicBrainz models
 * containment as a "part of" relation whose direction is "backward" on the
 * child (Aberdeen -> Grays Harbor County) and "forward" on the parent.
 */
export function parentAreaName(areaData) {
  const relation = areaData?.relations?.find(
    (rel) =>
      rel.type === "part of" && rel.direction === "backward" && rel.area?.name,
  );
  return relation?.area?.name ?? null;
}

/**
 * Display label for the resolved place. Nominatim's `addressdetails=1` gives
 * us the region for free on the request we already make, and showing it makes
 * a bad match obvious at a glance ("Aberdeen, South Dakota" reads as wrong in
 * a way that a bare "Aberdeen" never could).
 */
export function formatPlaceName(areaName, address) {
  const region = address?.state ?? address?.country;
  if (!region || region.toLowerCase() === areaName.toLowerCase()) {
    return areaName;
  }
  return `${areaName}, ${region}`;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, data: await response.json() };
}

/**
 * Second MusicBrainz hop, used only to disambiguate a sub-country area. Any
 * failure here degrades to `null` rather than failing the whole lookup: the
 * country filter alone still beats an unqualified search, and a transient
 * MusicBrainz blip shouldn't drop an artist off the map entirely.
 */
async function fetchParentAreaName(areaId) {
  try {
    const result = await fetchJson(
      `${MB_BASE}/area/${encodeURIComponent(areaId)}?inc=area-rels&fmt=json`,
    );
    if (!result.ok) {
      console.warn(
        `MusicBrainz returned ${result.status} for area rels: ${areaId}`,
      );
      return null;
    }
    return parentAreaName(result.data);
  } catch (err) {
    console.warn("fetchParentAreaName failed:", err.message);
    return null;
  }
}

// A single lookup can make two MusicBrainz requests: the artist search, then
// the area-parent lookup. Callers that rate-limit MusicBrainz must reserve
// airtime for both at once (see api/geocode.js) — acquiring a second slot
// mid-lookup would deadlock against the lock the first call still holds.
export const MUSICBRAINZ_CALLS_PER_LOOKUP = 2;

export async function lookupArtistLocation(
  artistName,
  { acquireNominatimThrottle } = {},
) {
  try {
    const mbResult = await fetchJson(
      `${MB_BASE}/artist/?query=artist:${encodeURIComponent(`"${artistName}"`)}&fmt=json`,
    );
    if (!mbResult.ok) {
      console.warn(
        `MusicBrainz returned ${mbResult.status} for artist: ${artistName}`,
      );
      return null;
    }

    const artist = mbResult.data.artists?.[0];
    if (!artist) return null;

    const area = selectArea(artist);
    const areaName = area?.name;
    if (!areaName) return null;

    // A country-level area is already unambiguous (and its parent would be a
    // continent), so the extra hop is only worth paying for cities/regions.
    const parentName =
      area.id && area.type !== "Country"
        ? await fetchParentAreaName(area.id)
        : null;

    if (acquireNominatimThrottle) {
      const granted = await acquireNominatimThrottle();
      if (!granted) return "THROTTLED";
    }

    const query = parentName ? `${areaName}, ${parentName}` : areaName;
    const countryCode = countryCodeFor(artist, area);
    const nomUrl =
      `${NOM_BASE}/search?q=${encodeURIComponent(query)}` +
      // accept-language pins the returned address labels to English —
      // without it Nominatim answers in the local language, which produced
      // place names like "Reykjavík, Ísland" next to "Compton, California".
      `&format=json&limit=1&addressdetails=1&accept-language=en` +
      (countryCode ? `&countrycodes=${encodeURIComponent(countryCode)}` : "");
    const nomResult = await fetchJson(nomUrl);
    if (!nomResult.ok) {
      console.warn(`Nominatim returned ${nomResult.status} for area: ${query}`);
      return null;
    }

    const match = nomResult.data[0];
    if (!match) return null;

    return {
      lat: parseFloat(match.lat),
      lng: parseFloat(match.lon),
      placeName: formatPlaceName(areaName, match.address),
    };
  } catch (err) {
    console.warn("lookupArtistLocation failed:", err.message);
    return null;
  }
}
