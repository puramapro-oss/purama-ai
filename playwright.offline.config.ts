import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['test/browser/offline-workspace.spec.ts', 'test/browser/offline-build.spec.ts'],
  outputDir: 'test-results/offline',
  timeout: 45_000,
  expect: { timeout: 6_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'test-results/offline-report.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4187',
    browserName: 'chromium',
    headless: true,
    serviceWorkers: 'allow',
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
    },
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
