import { expect, test, type Page } from '@playwright/test';

const APP_ORIGIN = 'http://127.0.0.1:4173';

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

async function isolateFromLiveApis(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === APP_ORIGIN) return route.continue();

    if (url.pathname.startsWith('/rest/v1/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'content-range': '0-0/0' },
        body: '[]',
      });
    }

    if (url.pathname.startsWith('/auth/v1/')) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Auth E2E non simulée pour cette requête' }),
      });
    }

    return route.abort('blockedbyclient');
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('purama_ai_intro_seen', '1');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
  });
  await isolateFromLiveApis(page);
});

test('les routes publiques critiques restent navigables hors ligne', async ({ page }) => {
  for (const path of ['/', '/pricing', '/login', '/signup', '/ecosystem', '/mentions-legales']) {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response?.ok(), `${path} doit répondre`).toBe(true);
    await expect(page.locator('body')).not.toBeEmpty();
  }
});

test('un visiteur est redirigé vers la connexion pour une route protégée', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
});

test('le parcours de connexion simulé ouvre le dashboard sans API live', async ({ page }) => {
  const now = Math.floor(Date.now() / 1000);
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'e2e@purama.test',
    email_confirmed_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: 'Test E2E' },
    created_at: new Date().toISOString(),
  };
  const accessToken = jwt({ sub: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, exp: now + 3600 });

  await page.route('**/auth/v1/token?grant_type=password', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'e2e-refresh', user }),
  }));

  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Mot de passe').fill('offline-password');
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Connexion' })).toHaveCount(0);
});

test('une erreur auth simulée produit un retour accessible', async ({ page }) => {
  await page.route('**/auth/v1/token?grant_type=password', (route) => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error_code: 'invalid_credentials', msg: 'Identifiants invalides' }),
  }));

  await page.goto('/login');
  await page.getByLabel('Email').fill('incorrect@purama.test');
  await page.getByLabel('Mot de passe').fill('incorrect-password');
  await page.getByRole('button', { name: 'Se connecter' }).click();

  await expect(page.getByText(/identifiants invalides/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('le CTA Origin Forge ne fabrique aucun résultat et mène au vrai parcours', async ({ page }) => {
  await page.goto('/');
  const section = page.locator('#origin-demo');
  await section.locator('textarea').fill('Créer un assistant de support client');
  await section.getByRole('button', { name: 'Continuer' }).click();

  await expect(page).toHaveURL(/\/signup\?next=(?:%2F|\/)dashboard(?:%2F|\/)creator-agent(?:%2F|\/)new$/i);
  await expect(page.locator('body')).not.toContainText(/SmartAssist|Prêt à déployer|TODO_LIVE_TEST|\[MOCK\]/i);
});

test('la page 404 expose un fallback et une action de retour accessibles', async ({ page }) => {
  await page.goto('/route-inconnue');
  await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
  await expect(page.getByRole('link', { name: /retour à l'accueil/i })).toBeVisible();
});
