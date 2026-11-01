import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [
    { find: '@/hooks/useAuth', replacement: resolve('tests/chat/auth.tsx') },
    { find: '@', replacement: resolve('src') },
  ] },
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://supabase.example.invalid'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('test-only-public-key'),
  },
  server: { host: '127.0.0.1', port: 4175, strictPort: true },
});
