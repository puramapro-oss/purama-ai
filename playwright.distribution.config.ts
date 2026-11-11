import { defineConfig, devices } from '@playwright/test';

// Execute the compiled production app with inert provider settings. The real
// worker is enabled for its offline test; distribution fixtures block it in
// their own contexts so that network-boundary assertions remain observable.
export default defineConfig({
  testDir: './tests',
  testMatch: /[\\/]tests[\\/](distribution|distribution-pwa)\.spec\.ts$/,
  timeout: 30_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  outputDir: 'test-results/distribution',
  reporter: [['html', { outputFolder: 'playwright-report/distribution', open: 'never' }], ['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'fr-FR',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js build --config tests/distribution/vite.config.ts --configLoader runner --mode production && node node_modules/vite/bin/vite.js preview --config tests/distribution/vite.config.ts --configLoader runner --mode production',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu'],
        },
      },
    },
    { name: 'tablet', use: { ...devices['iPad Pro 11'], viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { ...devices['iPhone 14'], viewport: { width: 375, height: 812 } } },
  ],
});
