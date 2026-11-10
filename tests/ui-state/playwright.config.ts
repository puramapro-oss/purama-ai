import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  outputDir: process.env.UI_STATE_OUTPUT_DIR || '../../test-results/ui-state',
  timeout: 20_000, expect: { timeout: 1500 },
  reporter: [['list'], ['json', { outputFile: process.env.UI_STATE_REPORT || '../../test-results/ui-state/report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4197', ...devices['Desktop Chrome'], serviceWorkers: 'block',
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args: ['--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu'],
    } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/ui-state/vite.config.ts --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4197/tests/ui-state/index.html',
    reuseExistingServer: false,
  },
});
