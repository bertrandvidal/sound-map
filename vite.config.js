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
      include: ["src/**/*.{js,jsx}", "server/**/*.js"],
      exclude: [
        "**/__tests__/**",
        "**/*.test.{js,jsx}",
        "src/test/setup.js",
        "src/main.jsx", // React DOM entry point (createRoot+render); no logic to test
        "server/index.js", // process entry point (env check + listen); logic lives in server/app.js
        "src/components/LeafletMap.jsx", // react-leaflet wrapper; needs real canvas/map sizing jsdom lacks
        "src/components/AlbumBubble.jsx", // builds a Leaflet divIcon; same canvas/DOM constraint
      ],
      thresholds: {
        // Global floor across every included file (components + app.js keep this realistic).
        statements: 80,
        branches: 70,
        functions: 85,
        // Pure-logic modules held to the strict bar, each file individually.
        "src/geo.js": {
          statements: 90,
          branches: 75,
          functions: 100,
          perFile: true,
        },
        "src/spotify.js": {
          statements: 90,
          branches: 75,
          functions: 100,
          perFile: true,
        },
        "src/pollError.js": {
          statements: 90,
          branches: 75,
          functions: 100,
          perFile: true,
        },
        "src/auth.js": {
          statements: 90,
          branches: 75,
          functions: 100,
          perFile: true,
        },
        "server/auth.js": {
          statements: 90,
          branches: 75,
          functions: 100,
          perFile: true,
        },
      },
    },
  },
});
