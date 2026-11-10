import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  timeout: 25_000, reporter: [['list']],
  outputDir: '../../test-results/wellbeing',
  use: {
    baseURL: 'http://127.0.0.1:4396', locale: 'fr-FR', ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: process.platform === 'linux' ? ['--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu'] : [] } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/wellbeing/vite.config.ts --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4396/tests/wellbeing/index.html', reuseExistingServer: false,
  },
});
