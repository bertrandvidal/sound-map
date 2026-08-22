import { overlayCardStyle } from "../theme.js";

// Fixed-position placement (bottom-left, beside BrowseLibraryButton) is
// owned by MapView's button row, not this component.
export default function ThemeToggleButton({ darkMode, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
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
