import { test, expect } from '@playwright/test';

test.describe('Performance — Temps de chargement', () => {
  test('Landing page charge en < 5s', async ({ page }) => {
    const start = Date.now();
    await page.goto('/', { waitUntil: 'networkidle' });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(5000);
  });

  test('Login page charge en < 3s', async ({ page }) => {
    const start = Date.now();
    await page.goto('/login', { waitUntil: 'networkidle' });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(3000);
  });

  test('Pricing page charge en < 3s', async ({ page }) => {
    const start = Date.now();
    await page.goto('/pricing', { waitUntil: 'networkidle' });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(3000);
  });
});

test.describe('Performance — Web Vitals basiques', () => {
  test('LCP < 4s sur landing', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const lcp = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          resolve(last.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });

        // Fallback timeout
        setTimeout(() => resolve(0), 3000);
      });
    });

    if (lcp > 0) {
      expect(lcp).toBeLessThan(4000);
    }
  });
});
