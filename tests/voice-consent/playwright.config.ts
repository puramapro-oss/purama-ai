import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  outputDir: '../../test-results/voice-consent',
  timeout: 30_000, reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4194', ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args: ['--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu'],
    } : {},
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/voice-consent/vite.config.ts --mode test',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4194/tests/voice-consent/index.html',
    reuseExistingServer: false,
  },
});
