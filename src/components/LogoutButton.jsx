import { SURFACE, TEXT } from "../theme.js";

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
        background: SURFACE,
        color: TEXT,
        border: "none",
        borderRadius: 12,
        padding: "10px 16px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        fontFamily: "sans-serif",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      Log out
    </button>
  );
}
