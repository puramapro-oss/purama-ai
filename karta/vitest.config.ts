import { defineConfig } from "vitest/config";

// Config dédiée pour éviter que vitest ne remonte jusqu'à vite.config.ts du projet parent
// (Vite React + @swc/core, sans rapport avec ce sous-projet Node.js).
export default defineConfig({
  // KARTA est un sous-projet Node pur. Une configuration PostCSS vide empêche Vite
  // de remonter jusqu'au postcss.config.js de l'application web parente.
  css: {
    postcss: { plugins: [] },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup-env.ts"],
  },
});
