import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // docuseal-e2e.spec.ts (playwright.docuseal.config.ts) et tests/karta/** (playwright.karta.config.ts)
  // ciblent la prod avec leur propre config dédiée (baseURL, env vars requises) — jamais dans la
  // suite locale par défaut.
  testIgnore: ['**/docuseal-e2e.spec.ts', '**/karta/**'],
  timeout: 30_000,
  retries: 2,
  fullyParallel: true,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview',
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    { name: 'tablet', use: { ...devices['iPad Pro 11'], viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { ...devices['iPhone 14'], viewport: { width: 375, height: 812 } } },
  ],
});
