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
  await page.context().route('**/*', async route => {
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
  await page.context().routeWebSocket('**/*', route => route.close());
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

for (const response of [{ url: 42 }, { url: 'javascript:window.invalidRedirect=true' }, { url: 'http://example.invalid/checkout' }, { url: '' }, { url: 'https://example.invalid/checkout' }, { url: 'https://checkout.stripe.com@evil.invalid/' }]) {
  test(`pricing releases checkout and rejects an invalid URL: ${JSON.stringify(response)}`, async ({ page }) => {
    await prepare(page, { ...activeSubscription, plan_type: 'free' });
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
  await prepare(page, { ...activeSubscription, plan_type: 'free' });
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

const checkoutRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReferralStorageFixture = {
  code?: string;
  ageDays?: number;
  timestamp?: string;
  boundCode?: string;
  deny?: 'read' | 'write' | 'timestamp' | 'silent-write';
  denyCleanup?: boolean;
};

async function prepareReferral(page: Page, storage: ReferralStorageFixture = {}, authenticated = true,
  hasUsedTrial = true) {
  const writes = await prepare(page,
    { ...activeSubscription, plan_type: 'free', status: 'canceled', has_used_trial: hasUsedTrial }, authenticated);
  const checkouts: Record<string, unknown>[] = [];
  const privateReads: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    // The shared navigation may read the signed-in user's own profile under RLS.
    // Referral capture must never look up another profile by code or a public RPC.
    if (url.pathname.endsWith('/rpc/resolve_referral_code')
      || (url.pathname.endsWith('/influencers') && url.searchParams.get('user_id') !== `eq.${userId}`)) {
      privateReads.push(request.url());
    }
  });
  await page.addInitScript(storage => {
    if (!sessionStorage.getItem('fixture_referral_seeded')) {
      if (storage.code) localStorage.setItem('referral_code', storage.code);
      if (storage.timestamp !== undefined) localStorage.setItem('referral_timestamp', storage.timestamp);
      else if (storage.code) {
        const timestamp = String(Date.now() - (storage.ageDays || 0) * 86_400_000);
        localStorage.setItem('referral_timestamp', storage.boundCode === undefined
          ? timestamp : `${timestamp}:${encodeURIComponent(storage.boundCode)}`);
      }
      sessionStorage.setItem('fixture_referral_seeded', '1');
    }
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (key) {
      if (storage.deny === 'read' && key.startsWith('referral_')) throw new DOMException('Fixture storage refusal', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('referral_')) {
        if (storage.deny === 'silent-write') return;
        if (storage.deny === 'write' || (storage.deny === 'timestamp' && key === 'referral_timestamp')) {
          throw new DOMException('Fixture quota refusal', 'QuotaExceededError');
        }
      }
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (storage.denyCleanup && key.startsWith('referral_')) throw new DOMException('Fixture cleanup refusal', 'SecurityError');
      return remove.call(this, key);
    };
  }, storage);
  await page.route('**/functions/v1/create-checkout', async route => {
    checkouts.push(route.request().postDataJSON());
    // Keep the test on the app: there is no provider session or real payment.
    return json(route, { url: '' });
  });
  return { checkouts, privateReads, errors, writes };
}

async function clickReferralCheckout(page: Page) {
  const starter = page.getByRole('heading', { name: 'Starter', exact: true }).locator('..');
  await starter.getByRole('button', { name: "S'abonner", exact: true }).click();
}

async function remountPricingWithinDocument(page: Page) {
  const marker = await page.evaluate(() => {
    const value = crypto.randomUUID();
    document.documentElement.dataset.referralTestDocument = value;
    return value;
  });
  await page.getByRole('link', { name: 'Retour', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/pricing`);
  expect(await page.evaluate(() => document.documentElement.dataset.referralTestDocument)).toBe(marker);
}

test('referral: direct pricing capture reaches the existing authoritative checkout endpoint', async ({ page }) => {
  const state = await prepareReferral(page);
  await page.goto('/pricing?ref=friend');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts).toEqual([
    { priceId: 'price_1TxuHo4Y1unNvKtXhx3LhtPW', requestId: expect.stringMatching(checkoutRequestId), referralCode: 'FRIEND' },
  ]);
  expect(state.privateReads).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('referral: the existing annual price is preserved when forwarding a saved code', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'FRIEND', ageDays: 14 });
  await page.goto('/pricing');
  await page.getByRole('button', { name: /Annuel/ }).click();
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts).toEqual([
    { priceId: 'price_1TxuHo4Y1unNvKtXX4yZ3BlN', requestId: expect.stringMatching(checkoutRequestId), referralCode: 'FRIEND' },
  ]);
  expect(state.privateReads).toEqual([]);
});

test('referral: direct pricing returns from password login with the recorded code', async ({ page }) => {
  const state = await prepareReferral(page, {}, false);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: expiresAt, role: 'authenticated' })).toString('base64')}.local-fixture`;
  await page.route('**/auth/v1/token?grant_type=password', route => json(route, {
    access_token: token, refresh_token: 'local-fixture', token_type: 'bearer',
    expires_in: 3600, expires_at: expiresAt, user,
  }));
  await page.goto('/pricing?ref=friend');
  await page.getByRole('heading', { name: 'Starter', exact: true }).locator('..').getByRole('button').click();
  await expect(page).toHaveURL(`${origin}/login?next=%2Fpricing`);
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill('fixture-password-only');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/pricing`);
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts[0]?.referralCode).toBe('FRIEND');
  expect(state.privateReads).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const authenticated of [false, true]) {
  test(`referral: home captures the code without reading a private profile (${authenticated ? 'authenticated' : 'anonymous'})`, async ({ page }) => {
    const state = await prepareReferral(page, {}, authenticated);
    await page.goto('/?ref=friend');
    await expect(page.getByText('Code enregistré : FRIEND. Son éligibilité sera vérifiée au paiement.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBe('FRIEND');
    expect(state.privateReads).toEqual([]);
    expect(state.checkouts).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test('referral: a previously saved invitation exposes only its code and survives the pricing link', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'FRIEND', ageDays: 14 });
  await page.route('**/rest/v1/influencers**', route => json(route,
    new URL(route.request().url()).searchParams.has('promo_code')
      ? { promo_code: 'FRIEND', beneficiary_name: 'PRIVATE BENEFICIARY FIXTURE' } : null));
  await page.goto('/');
  await expect(page.getByText('Invitation PURAMA : consultez les prix et conditions avant paiement.', { exact: true })).toBeVisible();
  expect(state.privateReads).toEqual([]);
  await expect(page.getByText('Code enregistré : FRIEND. Son éligibilité sera vérifiée au paiement.', { exact: true })).toBeVisible();
  await expect(page.getByText(/PRIVATE BENEFICIARY FIXTURE/)).toHaveCount(0);
  await page.getByRole('link', { name: 'Voir les prix', exact: true }).click();
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts[0]?.referralCode).toBe('FRIEND');
  expect(state.privateReads).toEqual([]);
});

test('referral: the short link keeps its seven-day cookie and forwards the same code', async ({ page, context }) => {
  const state = await prepareReferral(page);
  await page.goto('/go/friend');
  await expect(page).toHaveURL(`${origin}/?ref=FRIEND`);
  await expect(page.getByText(/Code enregistré : FRIEND/)).toBeVisible();
  const cookie = (await context.cookies()).find(value => value.name === 'purama_ref');
  expect(cookie?.value).toBe('FRIEND');
  expect(cookie?.expires).toBeGreaterThan(Date.now() / 1000 + 6.9 * 86_400);
  expect(cookie?.expires).toBeLessThan(Date.now() / 1000 + 7.1 * 86_400);
  await page.getByRole('link', { name: 'Voir les prix', exact: true }).click();
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts[0]?.referralCode).toBe('FRIEND');
  expect(state.privateReads).toEqual([]);
});

for (const deny of ['read', 'write', 'timestamp', 'silent-write'] as const) {
  test(`referral: ${deny} storage refusal cannot block checkout or forward a partial record`, async ({ page }) => {
    const state = await prepareReferral(page, { code: 'PREVIOUS', ageDays: 14, deny });
    await page.goto('/pricing?ref=friend');
    await clickReferralCheckout(page);
    await expect.poll(() => state.checkouts).toEqual([{ priceId: 'price_1TxuHo4Y1unNvKtXhx3LhtPW', requestId: expect.stringMatching(checkoutRequestId) }]);
    expect(state.privateReads).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

for (const path of ['/?ref=friend', '/go/friend']) {
  test(`referral: denied storage does not claim that the invitation was recorded at ${path}`, async ({ page }) => {
    const state = await prepareReferral(page, { deny: 'write' }, false);
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByText(/Code enregistré/)).toHaveCount(0);
    expect(state.privateReads).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test('referral: partial write plus denied cleanup stays invalid after remount and reload', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'PREVIOUS', ageDays: 14, deny: 'timestamp', denyCleanup: true });
  await page.goto('/pricing?ref=friend');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  // Remove the consumed query, then unmount/remount through the real router.
  await page.evaluate(() => window.history.replaceState(window.history.state, '', '/pricing'));
  await page.getByRole('link', { name: 'Retour', exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/pricing`);
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(2);
  // A new document must inspect the persisted pair, not a transient hook flag.
  await page.reload();
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(3);
  expect(state.checkouts).toEqual(Array.from({ length: 3 }, () => ({ priceId: 'price_1TxuHo4Y1unNvKtXhx3LhtPW', requestId: expect.stringMatching(checkoutRequestId) })));
  expect(state.privateReads).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('referral: a timestamp bound to another code cannot establish attribution', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'FRIEND', boundCode: 'OTHER', ageDays: 14 });
  await page.goto('/pricing');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts).toEqual([{ priceId: 'price_1TxuHo4Y1unNvKtXhx3LhtPW', requestId: expect.stringMatching(checkoutRequestId) }]);
  expect(state.privateReads).toEqual([]);
});

test('referral: a committed receipt survives reload and remains readable by the historical date parser', async ({ page }) => {
  const state = await prepareReferral(page);
  await page.goto('/pricing?ref=friend');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  const legacy = await page.evaluate(() => {
    const code = localStorage.getItem('referral_code');
    const timestamp = localStorage.getItem('referral_timestamp');
    if (!code || !timestamp || Date.now() - parseInt(timestamp) > 30 * 24 * 60 * 60 * 1000) return null;
    return { code, timestamp: parseInt(timestamp) };
  });
  expect(legacy?.code).toBe('FRIEND');
  expect(Number.isSafeInteger(legacy?.timestamp)).toBe(true);
  await page.goto('/pricing');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(2);
  expect(state.checkouts.every(body => body.referralCode === 'FRIEND')).toBe(true);
  expect(state.privateReads).toEqual([]);
});

for (const storage of [
  { code: 'OLD', ageDays: 31 },
  { code: 'BROKEN', timestamp: 'not-a-date' },
  { code: 'PARTIAL', timestamp: '123garbage' },
  { code: 'FUTURE', ageDays: -1 },
  { code: 'MISSING', timestamp: '' },
]) {
  test(`referral: stale or malformed storage is omitted (${storage.code})`, async ({ page }) => {
    const state = await prepareReferral(page, storage);
    await page.goto('/pricing');
    await clickReferralCheckout(page);
    await expect.poll(() => state.checkouts).toEqual([{ priceId: 'price_1TxuHo4Y1unNvKtXhx3LhtPW', requestId: expect.stringMatching(checkoutRequestId) }]);
    expect(state.privateReads).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test('referral: the card-free trial keeps the code without creating checkout or commissions', async ({ page }) => {
  const state = await prepareReferral(page, {}, true, false);
  const trials: unknown[] = [];
  await page.route('**/rest/v1/rpc/start_trial', async route => {
    trials.push(route.request().postDataJSON());
    return json(route, { plan_type: 'starter', status: 'trialing' });
  });
  await page.goto('/pricing?ref=friend');
  await page.getByRole('heading', { name: 'Starter', exact: true }).locator('..')
    .getByRole('button', { name: 'Essai 14 jours, sans carte', exact: true }).click();
  await expect.poll(() => trials).toEqual([{ p_plan_type: 'starter' }]);
  await expect(page).toHaveURL(`${origin}/dashboard`);
  expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBe('FRIEND');
  expect(state.checkouts).toEqual([]);
  expect(state.privateReads).toEqual([]);
  expect(state.writes.filter(path => /commission|checkout/.test(path))).toEqual([]);
});

test('referral: retry keeps its intent and explicit withdrawal starts a new intent without a code', async ({ page }) => {
  const state = await prepareReferral(page);
  await page.goto('/pricing?ref=friend');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(2);
  expect(state.checkouts[1]).toEqual(state.checkouts[0]);
  expect(state.checkouts[0].requestId).toMatch(checkoutRequestId);

  await page.getByRole('button', { name: 'Retirer le code', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/pricing`);
  await expect(page.getByText('Code de parrainage : FRIEND.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem('referral_code'), localStorage.getItem('referral_timestamp')])).toEqual([null, null]);
  expect(state.checkouts).toHaveLength(2); // Withdrawal itself must never create a payment.
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(3);
  expect(state.checkouts[2]).toEqual({
    priceId: state.checkouts[0].priceId, requestId: expect.stringMatching(checkoutRequestId),
  });
  expect(state.checkouts[2].requestId).not.toBe(state.checkouts[0].requestId);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retirer le code', exact: true })).toHaveCount(0);
});

test('referral: normalized code belongs to the intent even when the price does not change', async ({ page }) => {
  const state = await prepareReferral(page);
  await page.goto('/pricing?ref=friend');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  await page.evaluate(() => {
    history.pushState(history.state, '', '/pricing?ref=FRIEND');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(2);
  expect(state.checkouts[1]).toEqual(state.checkouts[0]);
  await page.evaluate(() => {
    history.pushState(history.state, '', '/pricing?ref=other');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('Code de parrainage : OTHER.', { exact: true })).toBeVisible();
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(3);
  expect(state.checkouts[2].priceId).toBe(state.checkouts[0].priceId);
  expect(state.checkouts[2].referralCode).toBe('OTHER');
  expect(state.checkouts[2].requestId).not.toBe(state.checkouts[0].requestId);
});

for (const search of ['ref=first&ref=second', 'ref=invalid%21code', 'ref=' + 'a'.repeat(65), 'ref=%20friend%20']) {
  test('referral: malformed or ambiguous public input is never saved or sent: ' + search, async ({ page }) => {
    const state = await prepareReferral(page);
    await page.goto('/pricing?' + search);
    await clickReferralCheckout(page);
    await expect.poll(() => state.checkouts.length).toBe(1);
    expect(state.checkouts[0]).toEqual({
      priceId: 'price_1TxuHo4Y1unNvKtXhx3LhtPW', requestId: expect.stringMatching(checkoutRequestId),
    });
    expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBeNull();
    expect(state.privateReads).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

for (const code of ['INVALID!CODE', 'A'.repeat(65)]) {
  test('referral: malformed historical code is omitted even with a recent timestamp: ' + code, async ({ page }) => {
    const state = await prepareReferral(page, { code, ageDays: 1 });
    await page.goto('/pricing');
    await clickReferralCheckout(page);
    await expect.poll(() => state.checkouts.length).toBe(1);
    expect(state.checkouts[0]).not.toHaveProperty('referralCode');
    expect(state.errors).toEqual([]);
  });
}

test('referral: a server refusal retains the invitation until the user explicitly withdraws it', async ({ page }) => {
  const state = await prepareReferral(page);
  await page.route('**/functions/v1/create-checkout', async route => {
    const body = route.request().postDataJSON();
    state.checkouts.push(body);
    return body.referralCode
      ? json(route, { error: 'Le code de parrainage n’est pas actif.', code: 'invalid_referral' }, 400)
      : json(route, { url: '' });
  });
  await page.goto('/pricing?ref=friend');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  const checkout = page.getByRole('heading', { name: 'Starter', exact: true }).locator('..').getByRole('button');
  await expect(checkout).toBeEnabled();
  await expect(page.getByText('Code de parrainage : FRIEND.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBe('FRIEND');
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(2);
  expect(state.checkouts[1]).toEqual(state.checkouts[0]);
  await page.getByRole('button', { name: 'Retirer le code', exact: true }).click();
  expect(state.checkouts).toHaveLength(2);
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(3);
  expect(state.checkouts[2]).not.toHaveProperty('referralCode');
  expect(state.checkouts[2].requestId).not.toBe(state.checkouts[0].requestId);
});

test('referral: denied durable removal is disclosed while explicit withdrawal applies to this visit', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'FRIEND', ageDays: 1, denyCleanup: true });
  await page.goto('/pricing');
  await page.getByRole('button', { name: 'Retirer le code', exact: true }).click();
  await expect(page.getByText('Code retiré pour cette visite. Ton navigateur empêche sa suppression durable ; il peut réapparaître après un rechargement.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBe('FRIEND');
  expect(state.checkouts).toEqual([]);
  await remountPricingWithinDocument(page);
  await expect(page.getByRole('button', { name: 'Retirer le code', exact: true })).toHaveCount(0);
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  expect(state.checkouts[0]).not.toHaveProperty('referralCode');
});

test('referral: double clicks and late responses stay isolated across accounts with a stored invitation', async ({ page }) => {
  const state = await prepareReferral(page);
  const pending: Array<{ body: Record<string, unknown>; release: () => void }> = [];
  const navigations: string[] = [];
  await page.route('https://checkout.stripe.com/**', route => { navigations.push(route.request().url()); return route.abort(); });
  await page.route('**/functions/v1/create-checkout', async route => {
    const index = pending.length;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    pending.push({ body: route.request().postDataJSON(), release });
    await gate;
    return json(route, { url: index === 0 ? 'https://checkout.stripe.com/c/pay/obsolete_referral' : '' });
  });
  await page.goto('/tests/quality/billing-scope-harness.html?ref=friend');
  const checkout = page.getByRole('heading', { name: 'Starter', exact: true }).locator('..').getByRole('button');
  await expect(checkout).toBeEnabled();
  await expect(page.getByText('Code de parrainage : FRIEND.', { exact: true })).toBeVisible();
  await checkout.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => pending.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Retirer le code', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Compte B', exact: true }).click();
  await expect(page.getByTestId('account')).toHaveText(/002$/);
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect.poll(() => pending.length).toBe(2);
  expect(pending.map(item => item.body.referralCode)).toEqual(['FRIEND', 'FRIEND']);
  expect(pending[1].body.requestId).not.toBe(pending[0].body.requestId);
  const finished = page.waitForEvent('requestfinished', { predicate: request => request.method() === 'POST' && request.url().endsWith('/create-checkout') });
  pending[0].release();
  await finished;
  await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(requestAnimationFrame); });
  expect(navigations).toEqual([]);
  await expect(page).toHaveURL(`${origin}/tests/quality/billing-scope-harness.html?ref=friend`);
  await expect(checkout).toBeDisabled(); // The obsolete request must not unlock the new account's action.
  pending[1].release();
  await expect(checkout).toBeEnabled();
  expect(state.privateReads).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('referral: a new explicit valid capture restores an invitation after a document-scoped withdrawal', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'FRIEND', ageDays: 1, denyCleanup: true });
  await page.goto('/pricing');
  await page.getByRole('button', { name: 'Retirer le code', exact: true }).click();
  await remountPricingWithinDocument(page);
  await expect(page.getByRole('button', { name: 'Retirer le code', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    history.pushState(history.state, '', '/pricing?ref=newfriend');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText('Code de parrainage : NEWFRIEND.', { exact: true })).toBeVisible();
  await clickReferralCheckout(page);
  await expect.poll(() => state.checkouts.length).toBe(1);
  expect(state.checkouts[0].referralCode).toBe('NEWFRIEND');
  expect(await page.evaluate(() => localStorage.getItem('referral_code'))).toBe('NEWFRIEND');
  expect(state.errors).toEqual([]);
});

test('referral: a late checkout response cannot revive a code withdrawn after its component unmounted', async ({ page }) => {
  const state = await prepareReferral(page, { code: 'FRIEND', ageDays: 1, denyCleanup: true });
  const navigations: string[] = [];
  let releaseOlder!: () => void;
  const oldRequest = new Promise<void>(resolve => { releaseOlder = resolve; });
  await page.route('https://checkout.stripe.com/**', route => { navigations.push(route.request().url()); return route.abort(); });
  await page.route('**/functions/v1/create-checkout', async route => {
    const first = state.checkouts.length === 0;
    state.checkouts.push(route.request().postDataJSON());
    if (first) await oldRequest;
    return json(route, { url: first ? 'https://checkout.stripe.com/c/pay/obsolete_invitation' : '' });
  });
  try {
    await page.goto('/pricing');
    await clickReferralCheckout(page);
    await expect.poll(() => state.checkouts.length).toBe(1);
    await remountPricingWithinDocument(page);
    await page.getByRole('button', { name: 'Retirer le code', exact: true }).click();
    const finished = page.waitForEvent('requestfinished', { predicate: request => request.method() === 'POST' && request.url().endsWith('/create-checkout') });
    releaseOlder();
    await finished;
    await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(requestAnimationFrame); });
    expect(navigations).toEqual([]);
    await remountPricingWithinDocument(page);
    await expect(page.getByRole('button', { name: 'Retirer le code', exact: true })).toHaveCount(0);
    await clickReferralCheckout(page);
    await expect.poll(() => state.checkouts.length).toBe(2);
    expect(state.checkouts[0].referralCode).toBe('FRIEND');
    expect(state.checkouts[1]).not.toHaveProperty('referralCode');
    expect(state.checkouts[1].requestId).not.toBe(state.checkouts[0].requestId);
    expect(state.errors).toEqual([]);
  } finally {
    releaseOlder();
  }
});
