import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/geo.js", "src/spotify.js"],
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 100,
      },
    },
  },
});
