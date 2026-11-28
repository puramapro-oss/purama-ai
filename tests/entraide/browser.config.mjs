import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  testDir: directory,
  testMatch: 'browser.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: join(directory, '../../test-results/entraide-browser'),
  reporter: [['list'], ['json', { outputFile: join(directory, '../../test-results/entraide-browser-report.json') }]],
  projects: [{ name: 'entraide-local', use: {
    browserName: 'firefox', viewport: { width: 1280, height: 900 },
    locale: 'fr-FR', reducedMotion: 'reduce',
    ...(process.env.ENTRAIDE_BROWSER_EXECUTABLE ? { launchOptions: { executablePath: process.env.ENTRAIDE_BROWSER_EXECUTABLE } } : {}),
  } }],
});
