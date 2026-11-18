import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file creates its own isolated in-process PostgreSQL (PGlite).
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
