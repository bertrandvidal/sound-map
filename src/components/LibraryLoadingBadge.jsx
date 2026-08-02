import { overlayCardStyle } from "../theme.js";
import "./libraryLoadingBadge.css";

// Background library resolution can take minutes for a large library; this
// pill surfaces progress while resolution is still catching up to the
// library size.
//
// "Still pending" is keyed on resolvedCount + failedCount, not resolvedCount
// alone: a backend failure (see useLibraryArtists.js's failedCount) is
// deliberately excluded from resolvedCount so it can never look like a false
// "done" — but without also counting it here, a run with real failures
// would leave the badge stuck below 100% forever instead of recognizing the
// loop has actually finished.
//
// Once nothing is left pending, the badge does NOT simply disappear if any
// artist failed: for a total backend outage every artist ends up
// "unavailable", ArtistClusterLayer only renders status === "resolved"
// markers, and hiding here as if nothing were wrong left the user staring
// at a confidently empty map with no error anywhere (this was Finding 3 in
// review — the earlier failedCount plumbing was necessary but not
// sufficient, since nothing actually rendered it). So a completed run with
// failures gets a terminal notice instead of silence; a completed run with
// zero failures still hides, matching the original "job's done" behavior.
export default function LibraryLoadingBadge({
  resolvedCount,
  total,
  failedCount = 0,
}) {
  if (total === 0) return null;

  const pending = resolvedCount + failedCount < total;
  if (!pending && failedCount === 0) return null;

  const message = pending
    ? `Loading library ${resolvedCount}/${total}`
    : `Library loaded — ${failedCount} artist${failedCount === 1 ? "" : "s"} could not be resolved`;

  return (
    <div
      role="status"
      aria-live="polite"
      // Only the in-progress state gets the "still working" pulse — a
      // terminal notice (nothing left pending) isn't ongoing activity, so
      // an animated pill would misrepresent it as still loading.
      className={pending ? "library-loading-badge" : undefined}
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
      {message}
    </div>
  );
}
