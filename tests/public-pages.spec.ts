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

      // Wait for the lazy route's actual content, not a network-idle loading
      // snapshot or a matching word inside an unloaded component's markup.
      await expect(p.locator('body')).toContainText(new RegExp(page.content, 'i'));
    });
  }

  test('/forge mène au véritable parcours de création pour un visiteur', async ({ page }) => {
    await page.goto('/forge', { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/signup\?next=(?:%2F|\/)dashboard(?:%2F|\/)creator-agent(?:%2F|\/)new$/i);
    await expect(page.getByRole('heading', { name: 'Créer un compte', exact: true })).toBeVisible();
  });
});

test.describe('Page 404', () => {
  test('/page-inexistante affiche 404', async ({ page }) => {
    await page.goto('/page-qui-existe-pas-du-tout', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: '404', exact: true })).toBeVisible();
  });
});

test.describe('Pas de Lorem/placeholder texte', () => {
  for (const path of ['/', '/pricing', '/ecosystem', '/parrainage']) {
    test(`${path} — 0 Lorem ipsum`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'networkidle' });
      const content = PUBLIC_PAGES.find(item => item.path === path)!.content;
      await expect(page.locator('body')).toContainText(new RegExp(content, 'i'));
      await expect(page.locator('body')).not.toContainText(/lorem ipsum/i);
    });
  }
});
