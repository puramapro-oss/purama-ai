import { expect, test, type Page, type Route } from '@playwright/test';

// Browser integration uses an isolated API double. Real SQL authorization and
// persistence are tested separately in creator-public-distribution.test.mjs.
const ORIGIN = 'http://127.0.0.1:4173';
const API_ORIGIN = 'http://127.0.0.1:54321';
const MODEL_ID = '81000000-0000-4000-8000-000000000001';
const USER_ID = '82000000-0000-4000-8000-000000000001';
const MODEL_PATH = `/modeles/${MODEL_ID}`;
const model = {
  id: MODEL_ID, name: 'Préparer ma semaine', description: 'Transformez vos priorités en un plan clair et personnalisable.',
  emoji: '🗓️', color: '#8B5CF6', category: 'productivity',
  is_public: true, is_template: false, is_active: true,
};

function session() {
  const now = Math.floor(Date.now() / 1000);
  const user = {
    id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'distribution@purama.test',
    email_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { full_name: 'Test Distribution' },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', email: user.email, exp: now + 3600 })}.`;
  return { access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'isolated-test-refresh', user };
}

async function installIsolatedApi(page: Page) {
  await page.routeWebSocket('**/*', socket => socket.close());
  const auth = session();
  const state = {
    available: true,
    readFailures: 0,
    readFailuresByKind: new Map<string, number>(),
    loseNextCopyResponse: false,
    publicReads: [] as Record<string, unknown>[],
    copies: [] as Record<string, unknown>[],
    records: new Map<string, Record<string, unknown>>(),
    unexpectedRequests: [] as string[],
  };
  const json = (route: Route, data: unknown, status = 200) => route.fulfill({
    status, contentType: 'application/json',
    headers: {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
    body: JSON.stringify(data),
  });

  await page.addInitScript(() => {
    // Do not dismiss the cinematic intro here: a deep link must avoid it itself.
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === ORIGIN) return route.continue();
    if (url.origin !== API_ORIGIN) return route.abort('blockedbyclient');
    if (request.method() === 'OPTIONS') return json(route, null);

    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') return json(route, auth);
    if (url.pathname === '/auth/v1/signup') return json(route, auth);
    if (url.pathname === '/auth/v1/user') return json(route, auth.user);

    if (url.pathname === '/rest/v1/rpc/public_creator_models') {
      expect(request.method()).toBe('POST');
      expect(request.headers()['content-profile']).toBe('purama_ai');
      const body = request.postDataJSON() as Record<string, unknown>;
      state.publicReads.push(body);
      const kindFailures = state.readFailuresByKind.get(String(body.p_kind)) ?? 0;
      if (kindFailures > 0) {
        state.readFailuresByKind.set(String(body.p_kind), kindFailures - 1);
        return json(route, { code: '503', message: 'Isolated catalogue failure' }, 503);
      }
      if (state.readFailures > 0) {
        state.readFailures -= 1;
        return json(route, { code: '503', message: 'Isolated unavailable service' }, 503);
      }
      const matches = body.p_id ? body.p_id === MODEL_ID : body.p_kind === 'community';
      return json(route, state.available && matches ? [model] : []);
    }
    if (url.pathname === '/rest/v1/rpc/clone_public_creator_model') {
      expect(request.method()).toBe('POST');
      expect(request.headers().authorization).toBe(`Bearer ${auth.access_token}`);
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['p_copy_id', 'p_expected_user_id', 'p_source_id']);
      expect(body.p_expected_user_id).toBe(USER_ID);
      expect(body.p_source_id).toBe(MODEL_ID);
      expect(body.p_copy_id).toMatch(/^[0-9a-f-]{36}$/);
      state.copies.push(body);
      const copyId = String(body.p_copy_id);
      if (!state.available && !state.records.has(copyId)) return json(route, { code: 'P0002', message: 'Model unavailable' }, 404);
      if (!state.records.has(copyId)) state.records.set(copyId, {
        ...model, id: copyId, user_id: USER_ID, slug: `copy-${copyId}`,
        is_public: false, is_template: false, cloned_from: MODEL_ID,
        system_prompt: 'Configuration du modèle copié.', model: 'claude-sonnet-4-20250514',
        temperature: 0.7, max_tokens: 4000, tools_enabled: [],
        schedule_enabled: false, schedule_cron: null, schedule_input: null,
        last_scheduled_run: null, karta_enabled: false, total_runs: 0, total_tokens: 0, avg_rating: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (state.loseNextCopyResponse) {
        state.loseNextCopyResponse = false;
        return json(route, { code: '503', message: 'Copy committed; response unavailable in this fixture' }, 503);
      }
      return json(route, state.records.get(copyId));
    }
    if (url.pathname === '/rest/v1/creator_agents') {
      expect(request.method()).toBe('GET');
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      return json(route, id ? state.records.get(id) ?? null : [...state.records.values()]);
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (!['GET', 'HEAD'].includes(request.method())) {
        state.unexpectedRequests.push(`${request.method()} ${url.pathname}`);
        return route.abort('blockedbyclient');
      }
      return json(route, []);
    }
    if (url.pathname.startsWith('/auth/v1/')) return json(route, { message: 'Unexpected auth request in isolated test' }, 503);
    state.unexpectedRequests.push(url.pathname);
    return route.abort('blockedbyclient');
  });
  return state;
}

async function signIn(page: Page, next = MODEL_PATH) {
  await page.goto(`/login?${new URLSearchParams({ next })}`);
  await page.getByLabel('Email', { exact: true }).fill('distribution@purama.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}${next}`);
}

test.use({ serviceWorkers: 'block' });

test('un lien public ouvre directement sa présentation sans compte ni introduction', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await page.goto(`${MODEL_PATH}?ref=AMB-42&access_token=secret#token`);
  await expect(page.getByRole('heading', { name: model.name, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Créer ma copie privée' })).toHaveAttribute('href', `/signup?${new URLSearchParams({ next: `${MODEL_PATH}?ref=AMB-42` })}`);
  await expect(page.getByRole('link', { name: /Se connecter et revenir/ })).toHaveAttribute('href', `/login?${new URLSearchParams({ next: `${MODEL_PATH}?ref=AMB-42` })}`);
  expect(api.publicReads).toEqual([{ p_id: MODEL_ID }]);
  expect(api.copies).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBe('AMB-42');
});

test('le partage copie le modèle public et exclut les paramètres sensibles', async ({ page }) => {
  await installIsolatedApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Clipboard refused in test')) } });
  });
  await page.goto(`${MODEL_PATH}?ref=AMB-42&access_token=secret#private`);
  await page.getByRole('button', { name: 'Copier le lien', exact: true }).click();
  const fallback = page.getByLabel('Lien public à copier');
  await expect(fallback).toHaveValue(`${ORIGIN}${MODEL_PATH}?ref=AMB-42`);
  await expect(fallback).toBeFocused();
  await expect(page.getByRole('status')).not.toContainText('Lien copié');
});

test('une destination invalide ne déclenche aucune requête publique ni copie', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await page.goto('/modeles/pas-un-identifiant');
  await expect(page.getByRole('heading', { name: 'Ce modèle n’est plus disponible' })).toBeVisible();
  await expect(page.getByRole('button', { name: /copie privée/i })).toHaveCount(0);
  expect(api.publicReads).toHaveLength(0);
  expect(api.copies).toHaveLength(0);
});

test('une panne de lecture propose une nouvelle tentative sans inventer un modèle', async ({ page }) => {
  const api = await installIsolatedApi(page);
  api.readFailures = 1;
  await page.goto(MODEL_PATH);
  await expect(page.getByRole('heading', { name: 'Impossible de charger ce modèle' })).toBeVisible();
  await expect(page.getByRole('heading', { name: model.name })).toHaveCount(0);
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(page.getByRole('heading', { name: model.name })).toBeVisible();
  expect(api.publicReads).toHaveLength(2);
});

test('connexion → même modèle → copie privée uniquement après action explicite', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await page.goto(`${MODEL_PATH}?ref=AMB-42`);
  await page.getByRole('link', { name: /Se connecter et revenir/ }).click();
  await page.getByLabel('Email', { exact: true }).fill('distribution@purama.test');
  await page.getByLabel('Mot de passe', { exact: true }).fill('isolated-password');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}${MODEL_PATH}?ref=AMB-42`);
  await expect(page.getByRole('button', { name: 'Créer ma copie privée', exact: true })).toBeEnabled();
  expect(api.copies).toHaveLength(0);
  await page.getByRole('button', { name: 'Créer ma copie privée', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/creator-agent\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: model.name, exact: true })).toBeVisible();
  expect(api.copies).toHaveLength(1);
  expect(api.records.size).toBe(1);
  expect(api.unexpectedRequests).toEqual([]);
});

test('inscription avec session simulée revient au modèle sans le copier automatiquement', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await page.goto(MODEL_PATH);
  await page.getByRole('link', { name: 'Créer ma copie privée', exact: true }).click();
  await page.getByLabel(/Nom complet/).fill('Test Distribution');
  await page.getByLabel(/^Email/).fill('distribution@purama.test');
  await page.getByLabel(/^Mot de passe/).fill('isolated-password');
  await page.getByLabel(/^Confirmer le mot de passe/).fill('isolated-password');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Créer mon compte', exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}${MODEL_PATH}`);
  await expect(page.getByRole('button', { name: 'Créer ma copie privée', exact: true })).toBeEnabled();
  expect(api.copies).toHaveLength(0);
});

test('une réponse perdue peut être retentée sans créer une seconde copie', async ({ page }) => {
  await page.clock.install();
  const api = await installIsolatedApi(page);
  api.loseNextCopyResponse = true;
  await signIn(page);
  await page.getByRole('button', { name: 'Créer ma copie privée', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('La copie n’a pas pu être confirmée');
  expect(api.records.size).toBe(1);
  // The current optional practice stays closed without consent while retries
  // remain usable; assert its real accessible name, not a retired overlay.
  await page.clock.runFor(1800);
  await expect(page.getByRole('button', { name: 'Pause facultative', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Un moment à ton rythme', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Créer ma copie privée', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/creator-agent\/[0-9a-f-]{36}$/);
  expect(api.copies).toHaveLength(2);
  expect(api.copies[0]).toEqual(api.copies[1]);
  expect(api.records.size).toBe(1);
});

test('deux clics consécutifs ne soumettent qu’une demande', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await signIn(page);
  const copy = page.getByRole('button', { name: 'Créer ma copie privée', exact: true });
  await expect(copy).toBeEnabled();
  await copy.evaluate(element => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(page).toHaveURL(/\/dashboard\/creator-agent\/[0-9a-f-]{36}$/);
  expect(api.copies).toHaveLength(1);
});

test('un retrait après ouverture est respecté au moment de la copie', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Créer ma copie privée', exact: true })).toBeEnabled();
  api.available = false;
  await page.getByRole('button', { name: 'Créer ma copie privée', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ce modèle n’est plus disponible' })).toBeVisible();
  expect(api.records.size).toBe(0);
});

test('le catalogue existant expose un vrai lien public partageable', async ({ page }) => {
  const api = await installIsolatedApi(page);
  await signIn(page, '/dashboard/creator-agent/templates');
  await expect(page.getByRole('button', { name: 'Copier le lien', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Voir la présentation publique', exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}${MODEL_PATH}`);
  await expect(page.getByRole('heading', { name: model.name, exact: true })).toBeVisible();
  expect(api.copies).toHaveLength(0);
});

test('une panne partielle du catalogue conserve les modèles disponibles et permet une reprise', async ({ page }) => {
  const api = await installIsolatedApi(page);
  api.readFailuresByKind.set('official', 1);
  await signIn(page, '/dashboard/creator-agent/templates');
  await expect(page.getByRole('alert')).toContainText('Une partie du catalogue');
  await expect(page.getByText('Aucun template dans cette catégorie.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Voir la présentation publique', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recharger le catalogue', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Aucun template dans cette catégorie.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Voir la présentation publique', exact: true })).toBeVisible();
});
