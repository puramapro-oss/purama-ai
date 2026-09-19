import { defineConfig } from "vitest/config";

// Config dédiée pour éviter que vitest ne remonte jusqu'à vite.config.ts du projet parent
// (Vite React + @swc/core, sans rapport avec ce sous-projet Node.js).
export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    maxWorkers: 2,
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
  },
});
