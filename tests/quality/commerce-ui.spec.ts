import { expect, test, type Page, type Route } from '@playwright/test';
import { qualityOrigin } from './quality-environment';

const origin = qualityOrigin;
const userId = '00000000-0000-4000-8000-000000000001';
const user = {
  id: userId, email: 'commerce-fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
};
const activeSubscription = {
  plan_type: 'pro', status: 'active', has_used_trial: true, trial_ends_at: null as string | null,
};

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({
    status, contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': route.request().headers()['access-control-request-headers'] || '*',
      'access-control-allow-methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
    },
    body: JSON.stringify(value),
  });
}

async function prepare(page: Page, subscription: unknown = activeSubscription, authenticated = true) {
  const writes: string[] = [];
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
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route, null);
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/subscriptions')) return json(route, subscription);
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    return json(route, []);
  });
  return writes;
}

const futureTrialEnd = '2099-01-01T00:00:00Z';
for (const scenario of [
  { name: 'active starter', row: { plan_type: 'starter' }, plan: 'starter' },
  { name: 'active pro', row: {}, plan: 'pro' },
  { name: 'active ultime', row: { plan_type: 'ultime' }, plan: 'ultime' },
  { name: 'uppercase plan', row: { plan_type: 'PRO' }, plan: 'pro' },
  { name: 'enterprise alias', row: { plan_type: 'enterprise' }, plan: 'ultime' },
  { name: 'free subscription', row: { plan_type: 'free' }, plan: 'free' },
  { name: 'unknown active plan', row: { plan_type: 'unknown' }, plan: 'free' },
  { name: 'prototype key', row: { plan_type: '__proto__' }, plan: 'free' },
  { name: 'constructor key', row: { plan_type: 'constructor' }, plan: 'free' },
  { name: 'cancelled subscription', row: { status: 'canceled' }, plan: 'free' },
  { name: 'expired trial', row: { status: 'trialing', trial_ends_at: '2000-01-01T00:00:00Z' }, plan: 'free' },
  { name: 'trial with invalid date', row: { status: 'trialing', trial_ends_at: 'invalid-date' }, plan: 'free' },
  { name: 'trial without end date', row: { status: 'trialing' }, plan: 'free' },
  { name: 'trial for unknown plan', row: { plan_type: 'unknown', status: 'trialing', trial_ends_at: futureTrialEnd }, plan: 'free' },
  { name: 'trial for free plan', row: { plan_type: 'free', status: 'trialing', trial_ends_at: futureTrialEnd }, plan: 'free' },
  { name: 'valid paid-plan trial', row: { status: 'trialing', trial_ends_at: futureTrialEnd }, plan: 'pro', trial: true },
]) {
  test(`subscription flags agree with the resolved plan: ${scenario.name}`, async ({ page }) => {
    await prepare(page, { ...activeSubscription, ...scenario.row });
    await page.goto('/tests/quality/commerce-ui-harness.html');
    const output = page.getByTestId('subscription-state');
    await expect(output).toBeVisible();
    await expect.poll(async () => JSON.parse(await output.textContent() || '{}')).toEqual({
      authReady: true, userId, isLoading: false,
      planId: scenario.plan, planObjectId: scenario.plan,
      hasSubscription: scenario.plan !== 'free',
      isStarter: scenario.plan === 'starter', isPro: scenario.plan === 'pro', isUltime: scenario.plan === 'ultime',
      isTrialing: !!scenario.trial, trialEndsAt: scenario.trial ? futureTrialEnd : null,
      hasUsedTrial: true,
    });
  });
}

test('signed-out subscription state stays free without requesting an account subscription', async ({ page }) => {
  await prepare(page, activeSubscription, false);
  const subscriptionRequests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/subscriptions')) subscriptionRequests.push(request.url());
  });
  await page.goto('/tests/quality/commerce-ui-harness.html');
  const output = page.getByTestId('subscription-state');
  await expect(output).toBeVisible();
  await expect.poll(async () => JSON.parse(await output.textContent() || '{}')).toMatchObject({
    authReady: true, userId: null, isLoading: false,
    planId: 'free', planObjectId: 'free', hasSubscription: false, isTrialing: false,
  });
  expect(subscriptionRequests).toEqual([]);
});

for (const flag of ['overage_success=true', 'overage_canceled=true', 'overage_success=true&overage_canceled=true']) {
  test(`checkout return cannot fabricate a payment or quota: ${flag}`, async ({ page }) => {
    const writes = await prepare(page);
    await page.goto(`/dashboard/billing?${flag}&keep=1`);
    await expect(page.getByRole('heading', { name: 'Abonnement & Utilisation' })).toBeVisible();
    await expect(page.getByText('Retour du paiement', { exact: true })).toBeVisible();
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
    await expect(page.getByText('Pack de dépassement activé', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Aucun montant débité.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Actions ce mois (0 / 6k)', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/dashboard/billing?keep=1`);
    expect(writes.filter(path => /commissions|overage_credits|checkout/.test(path))).toEqual([]);
  });
}

test('billing quota includes credits returned by the database without a checkout return flag', async ({ page }) => {
  await prepare(page);
  await page.route('**/rest/v1/overage_credits**', route => json(route, [{ actions: 2000 }]));
  await page.goto('/dashboard/billing');
  await expect(page.getByText('Actions ce mois (0 / 8k)', { exact: true })).toBeVisible();
  await expect(page.getByText('Retour du paiement', { exact: true })).toHaveCount(0);
});

test('pricing return flag leaves a free subscription unchanged', async ({ page }) => {
  const writes = await prepare(page, { ...activeSubscription, plan_type: 'free' });
  await page.goto('/pricing?success=true');
  await expect(page.getByText(/Retour du paiement reçu/)).toBeVisible();
  const freePlan = page.getByRole('heading', { name: 'Découverte', exact: true }).locator('..');
  await expect(freePlan.getByRole('button', { name: 'Plan actuel', exact: true })).toBeDisabled();
  await expect(page.getByText(/Paiement confirmé|Ton abonnement est actif/)).toHaveCount(0);
  expect(writes.filter(path => /subscriptions|checkout|start_trial/.test(path))).toEqual([]);
});

test('false pricing return flags do not display a payment banner', async ({ page }) => {
  await prepare(page);
  await page.goto('/pricing?success=false&canceled=false');
  await expect(page.getByRole('heading', { name: /Un prix/ })).toBeVisible();
  await expect(page.getByText(/Retour du paiement reçu|Paiement annulé|Retour après annulation/)).toHaveCount(0);
});

for (const response of [{ url: 42 }, { url: 'javascript:window.invalidRedirect=true' }, { url: 'http://example.invalid/checkout' }, { url: '' }]) {
  test(`pricing releases checkout and rejects an invalid URL: ${JSON.stringify(response)}`, async ({ page }) => {
    await prepare(page);
    await page.route('**/functions/v1/create-checkout', route => json(route, response));
    await page.goto('/pricing');
    const starter = page.getByRole('heading', { name: 'Starter', exact: true }).locator('..');
    const checkout = starter.getByRole('button', { name: "S'abonner", exact: true });
    await checkout.click();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
    await expect(checkout).toBeEnabled();
    await expect(page).toHaveURL(`${origin}/pricing`);
    expect(await page.evaluate(() => 'invalidRedirect' in window)).toBe(false);
  });
}

test('pricing follows the HTTPS checkout session returned by its server', async ({ page }) => {
  await prepare(page);
  const destination = 'https://checkout.stripe.com/c/pay/local_fixture';
  await page.route('**/functions/v1/create-checkout', route => json(route, { url: destination }));
  await page.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<h1>Local checkout fixture</h1>' }));
  await page.goto('/pricing');
  const starter = page.getByRole('heading', { name: 'Starter', exact: true }).locator('..');
  await starter.getByRole('button', { name: "S'abonner", exact: true }).click();
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole('heading', { name: 'Local checkout fixture' })).toBeVisible();
});

test('admin can inspect commissions and bank details without a fake payment action', async ({ page }) => {
  const writes = await prepare(page);
  const influencer = {
    id: 'influencer-fixture', user_id: userId, promo_code: 'FIXTURE30', affiliation_link: 'https://example.invalid/ref',
    commission_rate: 30, commission_tier: 'bronze', total_revenue: 29.85, total_sales: 1,
    contract_status: 'signed', contract_signed_at: '2026-01-01T00:00:00Z',
    iban: 'FR7612345678901234567890123', beneficiary_name: 'Partenaire de test',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', expires_at: futureTrialEnd,
  };
  const commission = {
    id: 'commission-fixture', influencer_id: influencer.id, client_id: 'customer-fixture',
    sale_amount: 99.50, commission_amount: 29.85, status: 'validated', payment_date: null,
    subscription_id: 'subscription-fixture', created_at: '2026-01-01T00:00:00Z',
  };
  await page.route('**/rest/v1/influencers**', route => json(route, [influencer]));
  await page.route('**/rest/v1/commissions**', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) writes.push('commission mutation');
    return json(route, [commission]);
  });
  await page.goto('/admin/influenceurs');
  await expect(page.getByRole('heading', { name: 'Gestion des Influenceurs' })).toBeVisible();
  await expect(page.getByText('Revenus enregistrés', { exact: true })).toBeVisible();
  await expect(page.getByText('Commissions payées', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Payer|Confirmer le paiement/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Détails', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(influencer.iban, { exact: true })).toBeVisible();
  await expect(dialog.getByText('+29.85€', { exact: true })).toBeVisible();
  await expect(dialog.getByText('validated', { exact: true })).toBeVisible();
  expect(writes.filter(path => /commission/.test(path))).toEqual([]);
});
