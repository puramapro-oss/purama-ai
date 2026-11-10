import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  outputDir: process.env.ASYNC_UI_OUTPUT_DIR || '../../test-results/async-ui',
  timeout: 20_000, expect: { timeout: 1500 },
  reporter: [['list'], ['json', { outputFile: process.env.ASYNC_UI_REPORT || '../../test-results/async-ui/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4198', ...devices['Desktop Chrome'], serviceWorkers: 'block',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu'],
    } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/async-ui/vite.config.ts --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4198/tests/async-ui/index.html', reuseExistingServer: false,
  },
});
