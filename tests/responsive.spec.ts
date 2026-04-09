import { test, expect } from '@playwright/test';

const PAGES_TO_CHECK = ['/', '/pricing', '/login', '/signup', '/ecosystem', '/parrainage'];

test.describe('Responsive — Pas de débordement horizontal', () => {
  for (const path of PAGES_TO_CHECK) {
    test(`${path} — pas d'overflow horizontal`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(hasOverflow).toBe(false);
    });
  }
});

test.describe('Responsive — Éléments visibles', () => {
  test('Landing page — hero visible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // Main heading should be visible
    const h1 = page.locator('h1').first();
    if (await h1.count() > 0) {
      await expect(h1).toBeVisible();
    }
  });

  test('Login — formulaire bien dimensionné', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });

    const form = page.locator('form').first();
    if (await form.count() > 0) {
      const box = await form.boundingBox();
      if (box) {
        const viewport = page.viewportSize();
        expect(box.width).toBeLessThanOrEqual(viewport!.width);
      }
    }
  });
});
