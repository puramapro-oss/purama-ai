import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';

export default defineConfig({
  cacheDir: "node_modules/.vite-voice-consent",
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: '@/hooks/useAuth', replacement: resolve('tests/voice-consent/auth.tsx') },
    { find: '@/lib/voice', replacement: resolve('tests/voice-consent/voice-services.ts') },
    { find: '@/integrations/supabase/client', replacement: resolve('tests/voice-consent/transport.ts') },
    { find: 'npm:zod@4.6.7', replacement: resolve('node_modules/zod/index.js') },
    { find: '@', replacement: resolve('src') },
  ] },
  optimizeDeps: { entries: ['tests/voice-consent/index.html'] },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://supabase.example.invalid'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('fixture-public-key'),
  },
  server: { host: '127.0.0.1', port: 4194, strictPort: true },
});
