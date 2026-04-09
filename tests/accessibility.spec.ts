import { test, expect } from '@playwright/test';

test.describe('Accessibilité — Basiques', () => {
  test('Landing — dark mode par défaut (bg sombre)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });
    // Dark mode: RGB values should be low
    const match = bgColor.match(/\d+/g);
    if (match) {
      const [r, g, b] = match.map(Number);
      expect(r + g + b).toBeLessThan(150); // Very dark
    }
  });

  test('Pages ont des headings structurés', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const h1Count = await page.locator('h1').count();
    expect(h1Count).toBeGreaterThanOrEqual(1);
  });

  test('Images ont des attributs alt', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const imagesWithoutAlt = await page.locator('img:not([alt])').count();
    // Allow max 2 decorative images without alt
    expect(imagesWithoutAlt).toBeLessThanOrEqual(2);
  });

  test('Boutons interactifs ont du texte accessible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const buttons = page.locator('button');
    const count = await buttons.count();

    for (let i = 0; i < Math.min(count, 20); i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible()) {
        const text = await btn.textContent();
        const ariaLabel = await btn.getAttribute('aria-label');
        const title = await btn.getAttribute('title');
        // At least one accessible identifier
        expect(text?.trim() || ariaLabel || title).toBeTruthy();
      }
    }
  });
});
