import { MUTED, TEXT } from "../theme.js";

const ellipsis = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export default function AlbumPopupCard({
  imageUrl,
  trackName,
  artistName,
  placeName,
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        width: 240,
        padding: 12,
        boxSizing: "border-box",
        color: TEXT,
        fontFamily: "sans-serif",
      }}
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt={artistName ?? ""}
          style={{
            width: 56,
            height: 56,
            borderRadius: 8,
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 15, ...ellipsis }}>
          {artistName}
        </div>
        <div style={{ color: MUTED, fontSize: 13, ...ellipsis }}>
          {trackName}
        </div>
        <div style={{ color: MUTED, fontSize: 12, marginTop: 2, ...ellipsis }}>
          📍 {placeName ?? "Unknown location"}
        </div>
      </div>
    </div>
  );
}
