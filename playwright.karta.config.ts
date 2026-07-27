import { defineConfig, devices } from '@playwright/test';

// Dedicated config for KARTA E2E (Mes employés IA, Créateur d'Agents, onboarding) against PROD —
// mêmes raisons que playwright.docuseal.config.ts : le moteur KARTA + les edge functions vivent
// uniquement sur le VPS, aucun mock local ne peut les remplacer.
export default defineConfig({
  testDir: './tests/karta',
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report-karta', open: 'never' }], ['list']],
  use: {
    baseURL: 'https://purama-ai.purama.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    { name: 'tablet', use: { ...devices['iPad Pro 11'], viewport: { width: 768, height: 1024 } } },
    { name: 'mobile', use: { ...devices['iPhone 14'], viewport: { width: 375, height: 812 } } },
  ],
});
