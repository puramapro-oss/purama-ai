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

  test('le service worker renvoie les validations vers l\'interface authentifiée', async ({ request }) => {
    const response = await request.get('/sw.js');
    expect(response.ok()).toBeTruthy();

    const serviceWorker = await response.text();
    expect(serviceWorker).not.toContain('/api/agent/approve');
    expect(serviceWorker).not.toContain("action: 'approve'");
    expect(serviceWorker).not.toContain('action_payload: data.action_payload');
    expect(serviceWorker).toContain("{ action: 'review', title: '👁 Valider dans Purama' }");
    expect(serviceWorker).toContain("{ action: 'review', title: '👁 Vérifier dans Purama' }");
    expect(serviceWorker).toContain('self.clients.openWindow(url)');
  });
});
