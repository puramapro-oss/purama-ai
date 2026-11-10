import { test, expect } from './public/fixtures';

test.describe('Accessibilité — Basiques', () => {
  test('Landing — dark mode par défaut (bg sombre)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.body).backgroundColor;
    });
    // Dark mode: RGB values should be low
    const match = bgColor.match(/\d+/g);
    expect(match).not.toBeNull();
    const [r, g, b] = match!.map(Number);
    expect(r + g + b).toBeLessThan(150); // Very dark
  });

  test('Pages ont des headings structurés', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const h1Count = await page.locator('h1').count();
    expect(h1Count).toBeGreaterThanOrEqual(1);
  });

  test('Images ont des attributs alt', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const imagesWithoutAlt = await page.locator('img:not([alt])').count();
    // Decorative images must still provide an empty alt attribute.
    expect(imagesWithoutAlt).toBe(0);
  });

  test('Boutons interactifs ont du texte accessible', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const buttons = page.locator('button:visible');
    const count = await buttons.count();

    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      await expect(btn).toHaveAccessibleName(/\S/);
    }
  });
});
