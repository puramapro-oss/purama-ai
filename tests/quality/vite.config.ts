import { defineConfig, mergeConfig } from 'vite';
import applicationConfig from '../../vite.config';
import { qualityHost, qualityPort } from './quality-environment';

export default defineConfig(env => {
  const config = mergeConfig(applicationConfig(env), {
    cacheDir: "node_modules/.vite-quality",
    resolve: { dedupe: ["react", "react-dom"] },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://supabase.example.invalid'),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('local-browser-test-key'),
    },
    server: { host: qualityHost, port: qualityPort, strictPort: true },
  });
  // mergeConfig skips null values, so set this after merging. The campaign
  // tests a fixed source snapshot, not HMR, and needs no shared file watches.
  config.server = { ...config.server, watch: null };
  return config;
});
