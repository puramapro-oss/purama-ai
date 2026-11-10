import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import appConfig from '../../vite.config';
import { publicSupabaseKey, publicSupabaseOrigin } from './environment';

// Compile the actual production entry and chunks, with inert provider settings.
// No local .env or provider secret is needed. No product module is replaced.
export default defineConfig(environment => mergeConfig(appConfig(environment), {
  envDir: false,
  cacheDir: fileURLToPath(new URL('./.cache/vite', import.meta.url)),
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(publicSupabaseOrigin),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(publicSupabaseKey),
  },
  build: { outDir: fileURLToPath(new URL('../../test-results/public-build', import.meta.url)) },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
}));
