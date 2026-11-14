import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  outputDir: '../../test-results/workshop-state',
  timeout: 30000, expect: { timeout: 5000 },
  reporter: [['list'], ['json', { outputFile: '../../test-results/workshop-state/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4198', ...devices['Desktop Chrome'], serviceWorkers: 'block',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/workshop-state/vite.config.ts --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4198/tests/workshop-state/index.html', reuseExistingServer: false,
  },
});
