import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../playwright.offline.config';
import { matrixProjects } from './matrix-projects';

// This existing suite creates its own isolated loopback server from real public
// assets. It does not need the compiled-app preview used by the other offline
// suites. Keep its service-worker and storage assertions intact on every engine.
export default defineConfig({
  ...baseline,
  testDir: fileURLToPath(new URL('../../../test/browser/', import.meta.url)),
  testMatch: 'offline-workspace.spec.ts',
  grep: [
    /autosave: retains offline typing and reopens the committed document without a save click$/,
    /prepares the real service worker, then reloads and persists an edited draft offline$/,
    /imports and searches real text safely at 390px without horizontal overflow$/,
    /preserves both conflicting versions across two tabs and never resurrects a deleted note$/,
    /reports denied browser storage without claiming a draft was saved$/,
    /exports unsaved text as a real download and restores it offline in a separately prepared profile$/,
  ],
  workers: 1,
  retries: 0,
  fullyParallel: false,
  outputDir: fileURLToPath(new URL('./results/offline/', import.meta.url)),
  reporter: [
    ['list'],
    ['json', { outputFile: fileURLToPath(new URL('./results/offline-report.json', import.meta.url)) }],
  ],
  use: {
    ...baseline.use,
    userAgent: undefined,
    launchOptions: undefined,
  },
  webServer: undefined,
  projects: matrixProjects,
});
