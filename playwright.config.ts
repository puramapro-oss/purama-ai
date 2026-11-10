import { defineConfig, devices } from '@playwright/test';
import { publicOrigin } from './tests/public/environment';

// Only the eight compiled public-site suites belong here. Dedicated harnesses
// and provider integrations must opt in through their own configuration.
export default defineConfig({
  testDir: './tests',
  testMatch: /[\\/]tests[\\/](accessibility|console-errors|forms-validation|navigation|performance|public-pages|pwa|responsive)\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: 'test-results/public',
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    ...devices['Desktop Chrome'],
    browserName: 'chromium',
    baseURL: publicOrigin,
    locale: 'fr-FR',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu',
        '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1'],
    },
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js build --config tests/public/vite.config.ts --configLoader runner --mode production && node node_modules/vite/bin/vite.js preview --config tests/public/vite.config.ts --configLoader runner --mode production',
    url: publicOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  // Viewport coverage with the same Chromium engine; these are not native
  // Safari/iOS tests and do not multiply the number of functional scenarios.
  projects: [
    { name: 'desktop', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'tablet', use: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } },
    { name: 'mobile', use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
});
