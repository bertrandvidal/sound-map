const USER_AGENT = "sound-map/0.1 (https://github.com/bertrandvidal/sound-map)";
const MB_BASE = "https://musicbrainz.org/ws/2";
const NOM_BASE = "https://nominatim.openstreetmap.org";

export async function lookupArtistLocation(artistName) {
  try {
    const mbUrl = `${MB_BASE}/artist/?query=artist:${encodeURIComponent(`"${artistName}"`)}&fmt=json`;
    const mbResponse = await fetch(mbUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!mbResponse.ok) {
      console.warn(
        `MusicBrainz returned ${mbResponse.status} for artist: ${artistName}`,
      );
      return null;
    }

    const mbData = await mbResponse.json();
    const artist = mbData.artists?.[0];
    if (!artist) return null;

    const areaName = artist["begin-area"]?.name ?? artist.area?.name;
    if (!areaName) return null;

    const nomUrl = `${NOM_BASE}/search?q=${encodeURIComponent(areaName)}&format=json&limit=1`;
    const nomResponse = await fetch(nomUrl, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!nomResponse.ok) {
      console.warn(
        `Nominatim returned ${nomResponse.status} for area: ${areaName}`,
      );
      return null;
    }

    const nomData = await nomResponse.json();
    if (!nomData[0]) return null;

    return {
      lat: parseFloat(nomData[0].lat),
      lng: parseFloat(nomData[0].lon),
      placeName: areaName,
    };
  } catch (err) {
    console.warn("lookupArtistLocation failed:", err.message);
    return null;
  }
}
