import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  timeout: 20_000, reporter: [['list']],
  outputDir: '../../test-results/chat',
  use: { baseURL: 'http://127.0.0.1:4175', ...devices['Desktop Chrome'],
    serviceWorkers: 'block',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu',
        '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1'],
    },
  },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config tests/chat/vite.config.ts --configLoader runner --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4175/tests/chat/index.html', reuseExistingServer: false },
});
