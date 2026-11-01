import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  timeout: 20_000, reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4175', ...devices['Desktop Chrome'],
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      args: ['--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--in-process-gpu'],
    } : {},
  },
  webServer: { command: 'npx vite --config tests/chat/vite.config.ts',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:4175/tests/chat/index.html', reuseExistingServer: false },
});
