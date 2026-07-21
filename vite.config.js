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
      include: [
        "src/geo.js",
        "src/spotify.js",
        "src/pollError.js",
        "src/auth.js",
      ],
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 100,
      },
    },
  },
});
