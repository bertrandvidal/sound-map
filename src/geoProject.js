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
