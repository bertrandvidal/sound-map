import { overlayCardStyle } from "../theme.js";

export default function ThemeToggleButton({ darkMode, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        position: "fixed",
        // Leaflet's own zoom control defaults to this same top-left corner
        // (~10px margin, ~62px tall for its two stacked buttons) — sitting
        // below it instead of on top avoids covering it.
        top: 90,
        left: 16,
        zIndex: 1000,
        border: "none",
        padding: "10px 16px",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        ...overlayCardStyle,
      }}
    >
      {darkMode ? "Light map" : "Dark map"}
    </button>
  );
}
