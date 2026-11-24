import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from '../../../playwright.config';
import { matrixProjects } from './matrix-projects';

const publicWebServer = baseline.webServer;
if (!publicWebServer || Array.isArray(publicWebServer)) {
  throw new Error('The canonical public-site harness must define one web server.');
}

// Reuse the compiled public-site harness, anonymous state, routing protections,
// and existing assertions. Provider and production integration suites stay out.
export default defineConfig({
  ...baseline,
  testDir: fileURLToPath(new URL('../../../tests/', import.meta.url)),
  testMatch: /[\\/]tests[\\/](responsive|navigation)\.spec\.ts$/,
  grep: [
    /pas d'overflow horizontal$/,
    /Landing page — hero visible$/,
    /Login — formulaire bien dimensionné$/,
    /Landing page — le CTA principal ouvre le formulaire d’inscription$/,
    /Navigation — redirect non-auth vers login$/,
  ],
  workers: 1,
  retries: 0,
  fullyParallel: false,
  outputDir: fileURLToPath(new URL('./results/public/', import.meta.url)),
  reporter: [
    ['list'],
    ['json', { outputFile: fileURLToPath(new URL('./results/public-report.json', import.meta.url)) }],
  ],
  use: {
    ...baseline.use,
    userAgent: undefined,
    launchOptions: undefined,
  },
  webServer: {
    ...publicWebServer,
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
  },
  projects: matrixProjects,
});
