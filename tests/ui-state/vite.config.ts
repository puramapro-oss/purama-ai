import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
export default defineConfig({
  cacheDir: "node_modules/.vite-ui-state",
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: '@/hooks/useAuth', replacement: resolve('tests/ui-state/auth-state.ts') },
    { find: '@/integrations/supabase/client', replacement: resolve('tests/ui-state/transport.ts') },
    { find: 'npm:zod@4.6.7', replacement: resolve('node_modules/zod/index.js') },
    { find: '@', replacement: resolve('src') },
  ] },
  optimizeDeps: { entries: ['tests/ui-state/index.html'] },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://supabase.example.invalid'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('fixture-public-key'),
  },
  server: { host: '127.0.0.1', port: 4197, strictPort: true },
});
