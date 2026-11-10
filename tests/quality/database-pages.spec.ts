import { test, expect, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

const userId = '00000000-0000-4000-8000-000000000001';
const user = { id: userId, email: 'fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify(value) });
}

async function prepare(page: Page, authenticated = false) {
  await page.addInitScript(({ authenticated, user }) => {
    localStorage.setItem('purama_ai_intro_seen', '1');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    if (authenticated) {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user.id, exp: expiresAt, role: 'authenticated' }))}.local-fixture`;
      localStorage.setItem('sb-supabase-auth-token', JSON.stringify({
        access_token: token, refresh_token: 'local-fixture', token_type: 'bearer',
        expires_in: 3600, expires_at: expiresAt, user,
      }));
    }
  }, { authenticated, user });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (route.request().method() === 'OPTIONS') return json(route, null, 200);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/user_tax_profiles')) return json(route, { profile_type: 'particulier_bnc', siret: null, company_name: null });
    return json(route, []);
  });
}

test('router preserves public navigation, unknown routes, and protected redirects', async ({ page }) => {
  await prepare(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /connexion/i }).first()).toBeVisible();
  await page.getByRole('link', { name: /inscri|créer un compte/i }).first().click();
  await expect(page).toHaveURL(/\/signup$/);
  await page.goto('/page-inexistante');
  await expect(page.getByText('404', { exact: true })).toBeVisible();
  await page.goto('/fiscal');
  await expect(page).toHaveURL(/\/login$/);
});

test('fiscal profile reads and saves in public without claiming a fabricated annual income', async ({ page }) => {
  await prepare(page, true);
  const reads: string[] = [];
  await page.route('**/rest/v1/user_tax_profiles**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      expect(request.headers()['content-profile']).toBe('public');
      expect(request.postDataJSON()).toMatchObject({ user_id: userId, profile_type: 'particulier_bnc' });
      return json(route, null, 201);
    }
    reads.push(request.headers()['accept-profile']);
    expect(new URL(request.url()).searchParams.get('user_id')).toBe(`eq.${userId}`);
    return json(route, { profile_type: 'particulier_bnc', siret: null, company_name: null });
  });
  await page.goto('/fiscal');
  await expect(page.getByText('Montant annuel indisponible')).toBeVisible();
  expect(reads).toContain('public');
  await expect(page.getByText('Aucune déclaration requise', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enregistrer mon profil fiscal' }).click();
  await expect(page.getByText('Profil fiscal enregistré.')).toBeVisible();
});

test('fiscal load failure is visible and retry restores the form', async ({ page }) => {
  await prepare(page, true);
  let fail = true;
  await page.route('**/rest/v1/user_tax_profiles**', route => json(route,
    fail ? { message: 'fixture unavailable' } : { profile_type: 'particulier_bnc', siret: null, company_name: null }, fail ? 503 : 200));
  await page.goto('/fiscal');
  await expect(page.getByRole('alert')).toContainText('Impossible de charger ton profil fiscal.');
  await expect(page.getByRole('button', { name: 'Enregistrer mon profil fiscal' })).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enregistrer mon profil fiscal' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('fiscal save failure releases the button and reports the failure', async ({ page }) => {
  await prepare(page, true);
  await page.route('**/rest/v1/user_tax_profiles**', route => route.request().method() === 'POST'
    ? json(route, { message: 'fixture write rejected' }, 503)
    : json(route, { profile_type: 'particulier_bnc', siret: null, company_name: null }));
  await page.goto('/fiscal');
  const save = page.getByRole('button', { name: 'Enregistrer mon profil fiscal' });
  await save.click();
  await expect(page.getByText('Impossible d’enregistrer le profil fiscal. Réessaie dans un instant.')).toBeVisible();
  await expect(save).toBeEnabled();
});

test('published rules use public and render a nullable publication date honestly', async ({ page }) => {
  await prepare(page);
  await page.route('**/rest/v1/reglements**', async route => {
    expect(route.request().headers()['accept-profile']).toBe('public');
    return json(route, [{ id: 'rules-fixture', version: 'test-1', type: 'cgv', content_hash: 'abc',
      opentimestamps_proof: null, blockchain: null, published_at: null, content_url: null }]);
  });
  await page.goto('/reglement');
  await expect(page.getByText('vtest-1', { exact: true })).toBeVisible();
  await expect(page.getByText('Date de publication indisponible')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preuve en attente' })).toBeDisabled();
});

test('failed rules request is not displayed as an empty publication list', async ({ page }) => {
  await prepare(page);
  let fail = true;
  await page.route('**/rest/v1/reglements**', route => json(route, fail ? { message: 'fixture unavailable' } : [], fail ? 503 : 200));
  await page.goto('/reglement');
  await expect(page.getByRole('alert')).toContainText('Impossible de charger les règlements.');
  await expect(page.getByText(/Aucun règlement publié/)).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(page.getByText(/Aucun règlement publié/)).toBeVisible();
});

test('dedicated application schema remains selected for wallet reads', async ({ page }) => {
  await prepare(page, true);
  const wallet = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/wallets'));
  await page.goto('/dashboard/wallet');
  expect((await wallet).headers()['accept-profile']).toBe('purama_ai');
});

test('Connect account reads use public and nullable provider flags remain disabled', async ({ page }) => {
  await prepare(page, true);
  await page.route('**/rest/v1/connect_accounts**', async route => {
    expect(route.request().headers()['accept-profile']).toBe('public');
    return json(route, [{ onboarding_completed: null, payouts_enabled: null, charges_enabled: true }]);
  });
  await page.goto('/login');
  const status = await page.evaluate(async () => {
    const modulePath = '/src/lib/stripe-connect.ts';
    const { getConnectStatus } = await import(modulePath);
    return getConnectStatus();
  });
  expect(status).toEqual({ has_account: true, onboarding_completed: false, payouts_enabled: false, charges_enabled: true });
});

test('Connect database failure returns an unknown status instead of a missing account', async ({ page }) => {
  await prepare(page, true);
  await page.route('**/rest/v1/connect_accounts**', route => json(route, { message: 'fixture unavailable' }, 503));
  await page.goto('/login');
  const status = await page.evaluate(async () => {
    const modulePath = '/src/lib/stripe-connect.ts';
    const { getConnectStatus } = await import(modulePath);
    return getConnectStatus();
  });
  expect(status).toBeNull();
});

test('Connect empty database result reports that no account exists', async ({ page }) => {
  await prepare(page, true);
  await page.route('**/rest/v1/connect_accounts**', route => json(route, []));
  await page.goto('/login');
  const status = await page.evaluate(async () => {
    const modulePath = '/src/lib/stripe-connect.ts';
    const { getConnectStatus } = await import(modulePath);
    return getConnectStatus();
  });
  expect(status).toEqual({ has_account: false, onboarding_completed: false, payouts_enabled: false, charges_enabled: false });
});

for (const response of [{ url: 42 }, { url: 'javascript:window.invalidRedirect=true' }]) {
  test(`billing rejects an invalid session URL: ${JSON.stringify(response)}`, async ({ page }) => {
    await prepare(page, true);
    await page.route('**/rest/v1/subscriptions**', route => json(route, {
      plan_type: 'pro', status: 'active', has_used_trial: false, trial_ends_at: null,
    }));
    await page.route('**/functions/v1/customer-portal', route => json(route, response));
    await page.goto('/dashboard/billing');
    const portal = page.getByRole('button', { name: 'Portail Stripe' });
    await portal.click();
    await expect(page.getByText("Impossible d'ouvrir le portail de facturation")).toBeVisible();
    await expect(portal).toBeEnabled();
    await expect(page).toHaveURL(/\/dashboard\/billing$/);
  });
}

test('billing follows a valid HTTPS session returned by its server', async ({ page }) => {
  await prepare(page, true);
  await page.route('**/rest/v1/subscriptions**', route => json(route, {
    plan_type: 'pro', status: 'active', has_used_trial: false, trial_ends_at: null,
  }));
  const destination = 'https://billing.stripe.com/p/session/local_fixture';
  await page.route('**/functions/v1/customer-portal', route => json(route, { url: destination }));
  await page.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<h1>Local portal fixture</h1>' }));
  await page.goto('/dashboard/billing');
  await page.getByRole('button', { name: 'Portail Stripe' }).click();
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole('heading', { name: 'Local portal fixture' })).toBeVisible();
});

test('pricing sends an existing paid subscriber to billing without starting another trial', async ({ page }) => {
  await prepare(page, true);
  let trials = 0;
  await page.route('**/rest/v1/subscriptions**', route => json(route, {
    plan_type: 'pro', status: 'active', has_used_trial: false, trial_ends_at: null,
  }));
  await page.route('**/rest/v1/rpc/start_trial', route => { trials++; return json(route, null); });
  await page.goto('/pricing');
  await expect(page.getByRole('button', { name: 'Essai 14 jours, sans carte', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Gérer mon abonnement', exact: true }).first().click();
  await expect(page).toHaveURL(/\/dashboard\/billing$/);
  expect(trials).toBe(0);
});

test('pricing waits for subscription data and exposes a failed lookup with a retry', async ({ page }) => {
  await prepare(page, true);
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  let fail = true;
  await page.route('**/rest/v1/subscriptions**', async route => {
    await hold;
    return json(route, fail ? { message: 'fixture unavailable' } : {
      plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null,
    }, fail ? 503 : 200);
  });
  await page.goto('/pricing');
  const waiting = page.getByRole('button', { name: 'Vérification de ton abonnement…', exact: true });
  await expect(waiting.first()).toBeVisible();
  for (const button of await waiting.all()) await expect(button).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('Impossible de vérifier ton abonnement.', { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Essai 14 jours, sans carte', exact: true }).first()).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Essai 14 jours, sans carte', exact: true }).first()).toBeEnabled();
});

test('pricing prevents another selection while the trial is pending and renders server errors', async ({ page }) => {
  await prepare(page, true);
  let calls = 0;
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/rest/v1/rpc/start_trial', async route => {
    calls++;
    expect(route.request().headers()['content-profile']).toBe('purama_ai');
    await hold;
    return json(route, { message: 'Essai déjà utilisé — fixture', code: 'P0001' }, 400);
  });
  await page.goto('/pricing');
  const buttons = page.getByRole('button', { name: 'Essai 14 jours, sans carte', exact: true });
  await buttons.first().click();
  await expect.poll(() => calls).toBe(1);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  release();
  await expect(page.getByText('Essai déjà utilisé — fixture', { exact: true })).toBeVisible();
  await expect(buttons.first()).toBeEnabled();
  expect(calls).toBe(1);
  await expect(page).toHaveURL(/\/pricing$/);
});

test('pricing lets a signed-out visitor select the free offer', async ({ page }) => {
  await prepare(page);
  await page.goto('/pricing');
  await page.getByRole('button', { name: 'Commencer gratuitement', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fpricing$/);
});

for (const index of [0, 1]) {
  test(`pricing lets a local trial convert through checkout on paid card ${index}`, async ({ page }) => {
    await prepare(page, true);
    let trials = 0;
    const checkouts: unknown[] = [];
    await page.route('**/rest/v1/subscriptions**', route => json(route, {
      plan_type: 'pro', status: 'trialing', has_used_trial: true,
      trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
    }));
    await page.route('**/rest/v1/rpc/start_trial', route => { trials++; return json(route, null); });
    const destination = 'https://checkout.stripe.com/c/pay/local_trial_fixture';
    await page.route('**/functions/v1/create-checkout', route => {
      checkouts.push(route.request().postDataJSON());
      return json(route, { url: destination });
    });
    await page.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<h1>Local checkout fixture</h1>' }));
    await page.goto('/pricing');
    await expect(page.getByRole('button', { name: 'Gérer mon abonnement', exact: true })).toHaveCount(0);
    // Card 1 is the current pro trial; card 0 selects a different plan.
    await page.getByRole('button', { name: "S'abonner", exact: true }).nth(index).click();
    await expect(page).toHaveURL(destination);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({ priceId: expect.any(String) });
    expect(trials).toBe(0);
  });
}
