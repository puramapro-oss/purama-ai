import { test, expect } from '@playwright/test';

test.beforeEach(async ({ context, baseURL }) => {
  await context.routeWebSocket('**/*', socket => socket.close());
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
});

test.describe('PWA — ressources publiques et secours hors ligne', () => {
  test('le manifeste et ses icônes sont réellement servis', async ({ request }) => {
    const response = await request.get('/manifest.json');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/application\/(?:manifest\+)?json/i);

    const manifest = await response.json();
    expect(manifest.name).toEqual(expect.any(String));
    expect(manifest.name.trim().length).toBeGreaterThan(0);
    expect(manifest.start_url).toEqual(expect.any(String));
    expect(new URL(manifest.start_url, response.url()).origin).toBe(new URL(response.url()).origin);
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons)).toBe(true);

    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons.find((item: { sizes: string }) => item.sizes === size);
      expect(icon, 'Une icône ' + size + ' doit être déclarée').toBeDefined();
      const iconURL = new URL(icon.src, response.url());
      expect(iconURL.origin).toBe(new URL(response.url()).origin);
      const iconResponse = await request.get(iconURL.href);
      expect(iconResponse.status()).toBe(200);
      expect(iconResponse.headers()['content-type']).toMatch(/^image\//);
      expect((await iconResponse.body()).byteLength).toBeGreaterThan(0);
    }
  });

  test('la page d’accueil référence obligatoirement le manifeste', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const manifestLink = page.locator('link[rel="manifest"]');
    await expect(manifestLink).toHaveCount(1);
    await expect(manifestLink).toHaveAttribute('href', '/manifest.json');
  });

  test('la page hors ligne prévue est une ressource publique disponible', async ({ page }) => {
    const response = await page.goto('/offline.html', { waitUntil: 'domcontentloaded' });
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-type']).toMatch(/text\/html/);
    await expect(page.getByRole('heading', { name: 'Tu es hors ligne', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Réessayer', exact: true })).toBeVisible();
  });

  test('le worker enregistré par l’application sert le secours après coupure réseau', async ({ page, context }) => {
    await page.goto('/', { waitUntil: 'load' });
    await expect.poll(
      () => page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const controller = navigator.serviceWorker.controller;
        return Boolean(
          registration?.active &&
          controller &&
          new URL(controller.scriptURL).pathname === '/sw.js'
        );
      }),
      { message: 'Le worker de PURAMA doit être actif et contrôler la page', timeout: 15_000 },
    ).toBe(true);

    await context.setOffline(true);
    try {
      const response = await page.goto('/dashboard?offline-check=1', { waitUntil: 'domcontentloaded' });
      expect(response?.status()).toBe(200);
      expect(response?.fromServiceWorker()).toBe(true);
      await expect(page.getByRole('heading', { name: 'Tu es hors ligne', exact: true })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
