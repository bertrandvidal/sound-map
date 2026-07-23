// Spotify-like dark palette, shared across the map overlay and the landing page.
export const SURFACE = "#181818";
export const SURFACE_ALT = "#282828";
export const ACCENT = "#1DB954";
export const TEXT = "#fff";
export const MUTED = "#b3b3b3";
export const STAGE = "#0a0a0a"; // full-viewport landing background

export const ellipsis = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

// Shared dark-surface card identity for the fixed overlays (now-playing + logout).
export const overlayCardStyle = {
  background: SURFACE,
  color: TEXT,
  borderRadius: 12,
  boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
  fontFamily: "sans-serif",
};
