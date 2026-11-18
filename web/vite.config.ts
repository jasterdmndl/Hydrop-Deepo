/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The Express API runs separately in development (npm run dev:server).
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
