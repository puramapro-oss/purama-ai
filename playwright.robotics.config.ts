import { defineConfig, devices } from '@playwright/test';

// Local build with fictitious credentials. Every remote request is intercepted by the tests.
export default defineConfig({
  testDir: './tests', testMatch: 'robotics.spec.ts', timeout: 30_000, retries: 0, workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174', browserName: 'chromium', serviceWorkers: 'block',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174', reuseExistingServer: false, timeout: 120_000,
    env: { VITE_SUPABASE_URL: 'https://robotics-test.invalid', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-only-public-key' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
});
