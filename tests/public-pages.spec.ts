import { test, expect } from '@playwright/test';

const PUBLIC_PAGES = [
  { path: '/', title: 'Purama AI', content: 'agent' },
  { path: '/login', title: 'Connexion', content: 'Connexion' },
  { path: '/signup', title: 'Inscription', content: 'Créer un compte' },
  { path: '/pricing', title: 'Tarifs', content: 'Gratuit' },
  { path: '/mentions-legales', title: 'Mentions', content: 'Mentions Légales' },
  { path: '/politique-de-confidentialite', title: 'Confidentialité', content: 'données' },
  { path: '/cgv', title: 'CGV', content: 'Conditions' },
  { path: '/cgu', title: 'CGU', content: 'Conditions' },
  { path: '/politique-cookies', title: 'Cookies', content: 'cookie' },
  { path: '/ecosystem', title: 'Ecosystem', content: 'Purama' },
  { path: '/parrainage', title: 'Parrainage', content: 'parrainage' },
  { path: '/concours', title: 'Concours', content: 'concours' },
  { path: '/classement', title: 'Classement', content: 'classement' },
  { path: '/forge', title: 'Forge', content: 'Forge' },
  { path: '/influenceur/inscription', title: 'Influenceur', content: 'partenaire' },
];

test.describe('Pages publiques — Chargement & Contenu', () => {
  for (const page of PUBLIC_PAGES) {
    test(`${page.path} retourne 200 et contient du contenu`, async ({ page: p }) => {
      const response = await p.goto(page.path, { waitUntil: 'networkidle' });
      expect(response?.status()).toBe(200);

      // Page has visible content (not blank)
      const body = await p.locator('body').textContent();
      expect(body?.length).toBeGreaterThan(10);

      // Specific content check (case insensitive)
      const html = await p.content();
      expect(html.toLowerCase()).toContain(page.content.toLowerCase());
    });
  }
});

test.describe('Page 404', () => {
  test('/page-inexistante affiche 404', async ({ page }) => {
    await page.goto('/page-qui-existe-pas-du-tout', { waitUntil: 'networkidle' });
    const text = await page.locator('body').textContent();
    expect(text?.toLowerCase()).toContain('404');
  });
});

test.describe('Pas de Lorem/placeholder texte', () => {
  for (const path of ['/', '/pricing', '/ecosystem', '/parrainage']) {
    test(`${path} — 0 Lorem ipsum`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      const text = await page.locator('body').textContent();
      expect(text?.toLowerCase()).not.toContain('lorem ipsum');
    });
  }
});
