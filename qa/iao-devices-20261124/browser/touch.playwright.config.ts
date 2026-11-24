import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import chat from './chat.playwright.config';
import { matrixProjects } from './matrix-projects';

export default defineConfig({
  ...chat,
  testDir: fileURLToPath(new URL('./', import.meta.url)),
  testMatch: 'touch.spec.ts',
  grep: undefined,
  outputDir: fileURLToPath(new URL('./results/touch/', import.meta.url)),
  reporter: [
    ['list'],
    ['json', { outputFile: fileURLToPath(new URL('./results/touch-report.json', import.meta.url)) }],
  ],
  // This scenario uses tap(), so only the three touch-enabled contexts belong.
  projects: [matrixProjects[0], matrixProjects[3], matrixProjects[4]],
});
