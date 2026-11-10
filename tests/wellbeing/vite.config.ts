import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
export default defineConfig({
  cacheDir: "node_modules/.vite-wellbeing",
  plugins: [react()],
  optimizeDeps: { entries: ['tests/wellbeing/index.html'] },
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: '@/hooks/useAuth', replacement: resolve('tests/wellbeing/auth.tsx') },
    { find: '@', replacement: resolve('src') },
  ] },
  server: { host: '127.0.0.1', port: 4396, strictPort: true },
});
