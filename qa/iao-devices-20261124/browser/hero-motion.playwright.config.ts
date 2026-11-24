import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './public.playwright.config';
import { matrixProjects } from './matrix-projects';

export default defineConfig({
  ...baseline,
  testDir: fileURLToPath(new URL('./', import.meta.url)),
  testMatch: 'hero-motion.spec.ts',
  grep: undefined,
  outputDir: fileURLToPath(new URL('./results/hero-motion/', import.meta.url)),
  reporter: [
    ['list'],
    ['json', { outputFile: fileURLToPath(new URL('./results/hero-motion-report.json', import.meta.url)) }],
  ],
  projects: [matrixProjects[2], matrixProjects[3], matrixProjects[4]],
});
