import { defineConfig } from "vitest/config";

// Config dédiée pour éviter que vitest ne remonte jusqu'à vite.config.ts du projet parent
// (Vite React + @swc/core, sans rapport avec ce sous-projet Node.js).
export default defineConfig({
  // PostCSS inline vide : empêche vite de remonter jusqu'au postcss.config.js du projet parent
  // (qui exige tailwindcss, absent de ce sous-projet Node.js sans CSS).
  css: { postcss: { plugins: [] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
