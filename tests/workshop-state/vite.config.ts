import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
export default defineConfig({
  cacheDir: 'node_modules/.vite-workshop-state',
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'], alias: [
    { find: '@/hooks/useAuth', replacement: resolve('tests/workshop-state/auth.ts') },
    { find: '@/integrations/supabase/client', replacement: resolve('tests/workshop-state/transport.ts') },
    { find: '@', replacement: resolve('src') },
  ] },
  optimizeDeps: { entries: ['tests/workshop-state/index.html'] },
  server: { host: '127.0.0.1', port: 4198, strictPort: true },
});
