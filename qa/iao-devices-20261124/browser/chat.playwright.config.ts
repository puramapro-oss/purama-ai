import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../tests/chat/playwright.config';
import { matrixProjects } from './matrix-projects';

// Existing real chat component and synthetic provider transport; no provider
// request, account creation, or production URL is introduced by this matrix.
export default defineConfig({
  ...baseline,
  testDir: fileURLToPath(new URL('../../../tests/chat/', import.meta.url)),
  testMatch: ['lifecycle.spec.ts', 'workshop.spec.ts'],
  grep: [
    /guest chat uses one model request, no history database calls and no welcome in model context$/,
    /two submits in the same browser task admit one request$/,
    /stop aborts the stream, removes partial output and restores the editable request$/,
    /a stale response cannot populate a new conversation or unlock a newer request$/,
    /account change during conversation creation prevents a subsequent model call$/,
    /retrying a failed model request reuses the confirmed user turn$/,
    /conversation to workshop preserves the source, supports another handoff on the mounted route, and starts only the edited request$/,
    /storage failure uses the fresh account-bound route and changing account clears its private draft$/,
    /landscape keeps preparation and the composer reachable and excludes stopped provisional output$/,
  ],
  workers: 1,
  retries: 0,
  fullyParallel: false,
  outputDir: fileURLToPath(new URL('./results/chat/', import.meta.url)),
  reporter: [
    ['list'],
    ['json', { outputFile: fileURLToPath(new URL('./results/chat-report.json', import.meta.url)) }],
  ],
  use: {
    ...baseline.use,
    userAgent: undefined,
    launchOptions: undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: matrixProjects,
});
