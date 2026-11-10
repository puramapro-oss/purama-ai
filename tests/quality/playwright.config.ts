import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { qualityOrigin } from './quality-environment';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: qualityOrigin,
    ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/quality/vite.config.ts --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: qualityOrigin,
    reuseExistingServer: false,
  },
});
