import { test, expect } from '@playwright/test';

const PAGES = ['/', '/pricing', '/login', '/signup', '/ecosystem'];

test.describe('Console — 0 erreur JS critique', () => {
  for (const path of PAGES) {
    test(`${path} — pas d'erreur console critique`, async ({ page }) => {
      const errors: string[] = [];

      page.on('pageerror', (err) => {
        // Ignore known non-critical errors
        const msg = err.message.toLowerCase();
        if (msg.includes('recaptcha') || msg.includes('gtag') || msg.includes('analytics') || msg.includes('posthog') || msg.includes('sentry')) return;
        errors.push(err.message);
      });

      await page.goto(path, { waitUntil: 'networkidle' });
      // Wait a bit for lazy components
      await page.waitForTimeout(1000);

      expect(errors).toEqual([]);
    });
  }
});
