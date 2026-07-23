import { MAP_HEIGHT, MAP_WIDTH, project } from "../geoProject.js";
import { ACCENT } from "../theme.js";
import { WORLD_PATHS } from "../worldMapPaths.js";

// Album bubbles pinned at real cities, in listening order (route connects them).
// Cities are illustrative choices for the decorative art, not user data.
const BUBBLES = [
  { lat: 47.6, lng: -122.3, r: 22, color: "#e35d5b" }, // Seattle
  { lat: -23.5, lng: -46.6, r: 20, color: "#b06ab3" }, // Sao Paulo
  { lat: 6.5, lng: 3.4, r: 20, color: "#f5c542" }, // Lagos (gold)
  { lat: 51.5, lng: -0.1, r: 26, color: "#3a7bd5" }, // London
  { lat: 35.7, lng: 139.7, r: 24, color: "#11998e" }, // Tokyo
];

const POINTS = BUBBLES.map((b) => ({ ...b, ...project(b.lat, b.lng) }));

// A gentle upward arc between two projected points.
function arc(a, b) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - 60;
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
}

export default function WorldMapBackdrop() {
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      <defs>
        <pattern
          id="sm-dots"
          width="11"
          height="11"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="2" cy="2" r="2" fill="#616161" />
        </pattern>
        <clipPath id="sm-land">
          {WORLD_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </clipPath>
      </defs>

      {/* subtle landmass fill so continents read against the near-black stage */}
      <rect
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        fill="#181818"
        clipPath="url(#sm-land)"
      />
      {/* bright dot-matrix, clipped to land */}
      <rect
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        fill="url(#sm-dots)"
        clipPath="url(#sm-land)"
      />

      {/* dashed green route threading the bubbles in order */}
      <g
        fill="none"
        stroke={ACCENT}
        strokeWidth="2.5"
        strokeDasharray="7 6"
        opacity="0.9"
      >
        {POINTS.slice(1).map((p, i) => (
          <path key={`${p.x}-${p.y}`} d={arc(POINTS[i], p)} />
        ))}
      </g>

      {/* soft shadows so bubbles feel anchored */}
      <g fill="#000" opacity="0.5">
        {POINTS.map((p) => (
          <ellipse
            key={`s-${p.x}-${p.y}`}
            cx={p.x}
            cy={p.y + p.r + 4}
            rx={p.r * 0.8}
            ry="5"
          />
        ))}
      </g>

      {/* the bubbles */}
      {POINTS.map((p) => (
        <circle
          key={`b-${p.x}-${p.y}`}
          data-testid="bubble"
          cx={p.x}
          cy={p.y}
          r={p.r}
          fill={p.color}
          stroke="#fff"
          strokeWidth="2.5"
        />
      ))}
    </svg>
  );
}
