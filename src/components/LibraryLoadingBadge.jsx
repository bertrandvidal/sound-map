import { overlayCardStyle } from "../theme.js";
import "./libraryLoadingBadge.css";

// Background library resolution can take minutes for a large library; this
// pill surfaces progress and disappears once resolution catches up to the
// library size (or there's nothing to resolve at all).
export default function LibraryLoadingBadge({ resolvedCount, total }) {
  if (total === 0 || resolvedCount >= total) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="library-loading-badge"
      style={{
        position: "fixed",
        bottom: 72,
        left: 16,
        zIndex: 1000,
        padding: "8px 16px",
        fontSize: 13,
        fontWeight: 600,
        ...overlayCardStyle,
      }}
    >
      Loading library {resolvedCount}/{total}
    </div>
  );
}
