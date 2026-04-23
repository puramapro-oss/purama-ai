import { defineConfig, devices } from '@playwright/test';

// Dedicated config for DocuSeal E2E against PROD (not local preview).
// Edge functions + DocuSeal live on VPS — tests must exercise the real backend.
export default defineConfig({
  testDir: './tests',
  testMatch: ['**/docuseal-e2e.spec.ts'],
  timeout: 120_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report-docuseal', open: 'never' }], ['list']],
  use: {
    baseURL: 'https://purama-ai.purama.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
