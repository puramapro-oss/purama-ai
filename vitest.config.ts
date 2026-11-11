import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    maxWorkers: 1,
    fileParallelism: false,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["tests/**", "karta/**", "supabase/**", "node_modules/**"],
  },
});
