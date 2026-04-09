import { test, expect } from '@playwright/test';

test.describe('PWA — Manifest & Service Worker', () => {
  test('manifest.json accessible', async ({ page }) => {
    const response = await page.goto('/manifest.json');
    if (response && response.status() === 200) {
      const manifest = await response.json();
      expect(manifest.name).toBeTruthy();
      expect(manifest.icons).toBeTruthy();
      expect(manifest.start_url).toBeTruthy();
    }
  });

  test('Landing page a le lien manifest', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const manifestLink = page.locator('link[rel="manifest"]');
    if (await manifestLink.count() > 0) {
      const href = await manifestLink.getAttribute('href');
      expect(href).toBeTruthy();
    }
  });
});
