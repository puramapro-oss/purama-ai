import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import appConfig from '../../vite.config';

export default defineConfig(environment => mergeConfig(appConfig(environment), {
  envDir: false,
  cacheDir: fileURLToPath(new URL('./.cache/vite', import.meta.url)),
  define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:54321'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('e2e-local-anon-key'),
  },
  build: { outDir: fileURLToPath(new URL('../../test-results/distribution-build', import.meta.url)) },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
}));
