import { overlayCardStyle } from "../theme.js";

export default function ThemeToggleButton({ darkMode, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        position: "fixed",
        top: 16,
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
