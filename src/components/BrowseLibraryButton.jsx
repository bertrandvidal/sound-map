import { overlayCardStyle } from "../theme.js";

export default function BrowseLibraryButton({ exploreMode, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        position: "fixed",
        bottom: 16,
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
      {exploreMode ? "Now playing" : "Browse library"}
    </button>
  );
}
