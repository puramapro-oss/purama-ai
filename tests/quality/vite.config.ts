import { defineConfig, mergeConfig } from 'vite';
import applicationConfig from '../../vite.config';

export default defineConfig(env => mergeConfig(applicationConfig(env), {
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://supabase.example.invalid'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('local-browser-test-key'),
  },
  server: { host: '127.0.0.1', port: 4176, strictPort: true },
}));
