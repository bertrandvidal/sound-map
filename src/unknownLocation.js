// Where a bubble goes when we have no idea where the artist is from: the
// empty mid-Pacific, far enough from any landmass that it can't be mistaken
// for a real origin. `unknown` marks it as the placeholder rather than a
// resolved location — LeafletMap.zoomForLocation keys its wide fly-out zoom
// off that flag (see UNKNOWN_ZOOM), because at ARTIST_ZOOM this spot is pure
// open water and reads as a broken map instead of as "we don't know".
//
// Shared by both views deliberately: now-playing (MapView, when
// lookupArtistLocation returns null) and explore mode (ArtistClusterLayer,
// for an artist the resolution loop marked not_found) must agree, or the same
// artist lands in two different places depending on how you got to them.
//
// Deliberately NOT in shared/geocode.js: that module is imported by the
// server too, and where to draw a bubble when we don't know is a UI decision,
// not a geocoding one — lookupArtistLocation returning null is the honest
// answer and stays that way.
//
// Frozen because ArtistClusterLayer spreads it onto artist objects — a shared
// mutable literal would let one consumer's edit leak into every other marker.
export const UNKNOWN_LOCATION = Object.freeze({
  lat: 0,
  lng: -160,
  placeName: "Unknown location",
  unknown: true,
});
