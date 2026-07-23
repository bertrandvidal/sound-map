import { overlayCardStyle } from "../theme.js";

export default function LogoutButton({ onLogout }) {
  return (
    <button
      type="button"
      onClick={onLogout}
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 1000,
        border: "none",
        padding: "10px 16px",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
        ...overlayCardStyle,
      }}
    >
      Log out
    </button>
  );
}
