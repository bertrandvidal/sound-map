import { overlayCardStyle } from "../theme.js";
import "./libraryLoadingBadge.css";

// Background library resolution can take minutes for a large library; this
// pill surfaces progress and disappears once resolution catches up to the
// library size (or there's nothing to resolve at all).
//
// Hiding is keyed on resolvedCount + failedCount, not resolvedCount alone:
// this badge's job is signalling "still loading", not "fully resolved". A
// backend failure (see useLibraryArtists.js's failedCount) is deliberately
// excluded from resolvedCount so it can never look like a false "done" —
// but without also counting it here, a run with real failures would leave
// the badge stuck below 100% forever instead of just disappearing once
// there's nothing left pending.
export default function LibraryLoadingBadge({
  resolvedCount,
  total,
  failedCount = 0,
}) {
  if (total === 0 || resolvedCount + failedCount >= total) return null;

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
