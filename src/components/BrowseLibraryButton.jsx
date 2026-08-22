import { overlayCardStyle } from "../theme.js";

// Fixed-position placement (bottom-left) is owned by MapView's button row,
// not this component — it sits alongside ThemeToggleButton there.
export default function BrowseLibraryButton({ exploreMode, onToggle }) {
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
      {exploreMode ? "Now playing" : "Browse library"}
    </button>
  );
}
