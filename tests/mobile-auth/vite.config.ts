import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const fixtureTsConfig = JSON.stringify({ compilerOptions: { jsx: "react-jsx", target: "ES2022" } });
export default defineConfig({
  root: here,
  cacheDir: path.join(here, ".cache/vite"),
  // Compile only this isolated React fixture without installing Expo's tsconfig.
  esbuild: { jsx: "automatic", tsconfigRaw: fixtureTsConfig },
  resolve: {
    alias: [
      { find: "@/lib/supabase", replacement: path.join(here, "mocks/supabase.ts") },
      { find: "react-native", replacement: path.join(here, "mocks/react-native.ts") },
      { find: "expo-web-browser", replacement: path.join(here, "mocks/expo-web-browser.ts") },
      { find: "expo-linking", replacement: path.join(here, "mocks/expo-linking.ts") },
      { find: "@", replacement: path.join(root, "mobile") },
    ],
    dedupe: ["react", "react-dom"],
  },
  server: { host: "127.0.0.1", port: 4199, strictPort: true, fs: { allow: [root, path.resolve(root, "../iao-frontend")] } },
  optimizeDeps: {
    entries: [path.join(here, "harness.tsx")],
    esbuildOptions: { tsconfigRaw: fixtureTsConfig },
  },
});
