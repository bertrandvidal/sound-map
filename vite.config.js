import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.{js,jsx}", "server/**/*.js", "api/**/*.js"],
      // Disallow-list: the ONLY files exempt from the strict per-file bar below.
      // Everything else — including any NEW file — must meet the bar. Do not add
      // a file here to make coverage pass; if a file can't be tested, ask first.
      exclude: [
        "**/__tests__/**",
        "**/*.test.{js,jsx}",
        "src/test/setup.js",
        "src/main.jsx", // React DOM entry point (createRoot+render); no logic
        "server/index.js", // process entry point (env check + listen)
        "src/components/LeafletMap.jsx", // react-leaflet wrapper; needs real canvas/map sizing jsdom lacks
        "src/components/AlbumBubble.jsx", // builds a Leaflet divIcon + Popup; same canvas/DOM constraint
      ],
      thresholds: {
        // One strict bar, applied to every included file individually. New
        // logic files are gated automatically — no per-file allow-list to keep
        // in sync.
        perFile: true,
        statements: 90,
        branches: 75,
        functions: 100,
      },
    },
  },
});
