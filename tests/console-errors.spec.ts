import { test, expect } from './public/fixtures';

const PAGES = ['/', '/pricing', '/login', '/signup', '/ecosystem'];

test.describe('Console — 0 erreur JS critique', () => {
  for (const path of PAGES) {
    test(`${path} — pas d'erreur console critique`, async ({ page }) => {
      const errors: string[] = [];

      page.on('pageerror', (err) => {
        errors.push(err.message);
      });

      await page.goto(path, { waitUntil: 'networkidle' });
      // Wait a bit for lazy components
      await page.waitForTimeout(1000);

      expect(errors).toEqual([]);
    });
  }
});
