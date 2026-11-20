import { test, expect } from './public/fixtures';

type NativeLcpReport = {
  supported: boolean;
  collectorError: string | null;
  visibility: string[];
  candidates: { startTime: number; size: number | null; element: string | null }[];
  paints: { name: string; startTime: number }[];
};

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
  test('LCP < 4s sur landing', async ({ page }, testInfo) => {
    // Observe the real browser before navigation. A larger candidate can follow
    // the first callback; a missing measurement must never become a fake zero.
    // https://developer.mozilla.org/en-US/docs/Web/API/LargestContentfulPaint
    await page.addInitScript(() => {
      const candidates: NativeLcpReport['candidates'] = [];
      const visibility = [document.visibilityState];
      const onVisibility = () => visibility.push(document.visibilityState);
      document.addEventListener('visibilitychange', onVisibility);
      const supported = typeof PerformanceObserver !== 'undefined'
        && PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint');
      let observer: PerformanceObserver | undefined;
      let collectorError: string | null = null;
      const collect = (entries: PerformanceEntry[]) => {
        for (const entry of entries) {
          const paint = entry as PerformanceEntry & { size?: number; element?: Element | null };
          candidates.push({
            startTime: paint.startTime,
            size: paint.size ?? null,
            element: paint.element?.tagName ?? null,
          });
        }
      };
      try {
        if (supported) {
          observer = new PerformanceObserver(list => collect(list.getEntries()));
          observer.observe({ type: 'largest-contentful-paint', buffered: true });
        }
      } catch (error) {
        collectorError = error instanceof Error ? error.message : String(error);
      }
      (window as unknown as { readNativeLcp: () => NativeLcpReport }).readNativeLcp = () => {
        if (observer) {
          collect(observer.takeRecords());
          observer.disconnect();
        }
        document.removeEventListener('visibilitychange', onVisibility);
        return {
          supported, collectorError, visibility, candidates,
          paints: performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime })),
        };
      };
    });

    await page.bringToFront();
    await page.goto('/', { waitUntil: 'networkidle' });
    // A fixed laboratory observation window, measured from navigation, captures
    // later native candidates too. It is not a real-user percentile or a claim
    // that no larger candidate can ever appear after this five-second window.
    await page.evaluate(() => new Promise<void>(resolve => {
      setTimeout(resolve, Math.max(0, 5000 - performance.now()));
    }));
    const report = await page.evaluate(() =>
      (window as unknown as { readNativeLcp: () => NativeLcpReport }).readNativeLcp());
    await testInfo.attach('native-lcp', {
      body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json',
    });

    expect(report.supported, 'The browser must support native LCP observation').toBe(true);
    expect(report.collectorError).toBeNull();
    expect(report.visibility.every(state => state === 'visible'), 'Measure a foreground page').toBe(true);
    const lcp = report.candidates.at(-1)?.startTime;
    expect(Number.isFinite(lcp), 'A missing LCP measurement is not a successful measurement').toBe(true);
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThan(4000);
  });
});
