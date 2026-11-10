import { test, expect } from './public/fixtures';

// Service workers are blocked by the network fixture. This suite qualifies
// the manifest/resources only, never offline mode or installation.
test.describe('PWA — Manifeste et ressources', () => {
  test('manifest.json accessible', async ({ page }) => {
    const response = await page.goto('/manifest.json');
    expect(response?.status()).toBe(200);
    const manifest = await response!.json();
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toMatch(/^\//);
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThan(0);
    // Chromium's JSON viewer is not an application document. Fetch the icon
    // bytes from real local HTML, under the same context network interception.
    const document = await page.goto('/login', { waitUntil: 'networkidle' });
    expect(document?.headers()['content-type']).toMatch(/^text\/html/);
    for (const icon of manifest.icons) {
      expect(icon.src).toMatch(/^\/(?!\/)/);
      // Navigating to an ICO may initiate a download. Fetch it through the
      // browser context so the same strict network boundary still applies.
      const asset = await page.evaluate(async src => {
        const url = new URL(src, window.location.href);
        // Playwright 1.59 classifies exact /favicon.ico URLs as automatic
        // favicons and aborts them before route handlers. This query keeps
        // the same local resource path while allowing the explicit check.
        if (url.pathname === '/favicon.ico') url.searchParams.set('qualification', 'public-resource');
        const response = await fetch(url.href);
        return { status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };
      }, icon.src);
      expect(asset.status).toBe(200);
      expect(asset.type).toMatch(/^image\//);
      expect(asset.bytes).toBeGreaterThan(0);
    }
  });

  test('Landing page a le lien manifest', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveCount(1);
    await expect(manifestLink).toHaveAttribute('href', '/manifest.json');
  });
});
