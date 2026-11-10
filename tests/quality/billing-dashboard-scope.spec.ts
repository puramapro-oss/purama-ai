import { expect, test, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

type Action = 'portal' | 'overage';
const harnessPath = '/tests/quality/billing-dashboard-scope-harness.html';
const endpoint = (action: Action) => action === 'portal' ? 'customer-portal' : 'create-checkout';
const stripeUrl = (action: Action) => action === 'portal'
  ? 'https://billing.stripe.com/p/session/fixture' : 'https://checkout.stripe.com/c/pay/fixture';
const actionButton = (page: Page, action: Action) => action === 'portal'
  ? page.getByRole('button', { name: 'Portail Stripe', exact: true })
  : page.getByRole('button', { name: /^Acheter \+/ });

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': route.request().headers()['access-control-request-headers'] ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  }, body: JSON.stringify(data) });
}

async function prepare(page: Page, subscriptionError = false) {
  const navigations: string[] = [];
  let failSubscription = subscriptionError;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    // Count attempted redirections even though no Stripe or other external
    // document may be fetched by this browser fixture.
    if (request.isNavigationRequest()) {
      navigations.push(url.href);
      return route.abort();
    }
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route, null);
    if (request.method() === 'GET' && url.pathname.endsWith('/user_agent_selections')) return json(route, []);
    if (request.method() === 'GET' && url.pathname.endsWith('/subscriptions')) {
      return failSubscription ? json(route, { message: 'fixture unavailable' }, 503)
        : json(route, { plan_type: 'pro', status: 'active', has_used_trial: true, trial_ends_at: null });
    }
    return route.abort();
  });
  await page.goto(`${harnessPath}${subscriptionError ? '?uncached=1' : ''}`);
  await expect(page.getByRole('heading', { name: 'Abonnement & Utilisation', exact: true })).toBeVisible();
  if (!subscriptionError) {
    await expect(actionButton(page, 'portal')).toBeEnabled();
    await expect(actionButton(page, 'overage')).toBeEnabled();
  }
  return { navigations, recoverSubscription: () => { failSubscription = false; } };
}

async function routeAction(page: Page, action: Action, handler: (route: Route) => Promise<void>) {
  await page.route(`**/functions/v1/${endpoint(action)}`, route => {
    if (route.request().method() === 'OPTIONS') return json(route, null);
    if (route.request().method() !== 'POST') return route.abort();
    return handler(route);
  });
}

async function delayAction(page: Page, action: Action, result: unknown, status = 200) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: Array<{ requestId?: string; priceId?: string } | null> = [];
  await routeAction(page, action, async route => {
    calls.push(route.request().postDataJSON());
    await gate;
    await json(route, result, status);
  });
  return { release, calls };
}

async function drain(page: Page, clock = false) {
  if (clock) await page.clock.runFor(50);
  else await page.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(requestAnimationFrame);
  });
}

async function finishDelayed(page: Page, action: Action, release: () => void, clock = false) {
  const finished = page.waitForEvent('requestfinished', {
    predicate: request => request.method() === 'POST' && request.url().endsWith(`/${endpoint(action)}`),
  });
  release();
  await finished;
  await drain(page, clock);
}

async function switchAccount(page: Page, transition: 'B' | 'B-A' | 'logout' | 'unmount') {
  if (transition === 'logout') {
    await page.getByRole('button', { name: 'Déconnexion fixture', exact: true }).click();
    await expect(page.getByTestId('account')).toHaveText('signed-out');
  } else if (transition === 'unmount') {
    await page.getByRole('button', { name: 'Masquer facturation fixture', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Abonnement & Utilisation', exact: true })).toHaveCount(0);
  } else {
    await page.getByRole('button', { name: 'Compte B', exact: true }).click();
    await expect(page.getByTestId('account')).toHaveText(/002$/);
    if (transition === 'B-A') {
      await page.getByRole('button', { name: 'Compte A', exact: true }).click();
      await expect(page.getByTestId('account')).toHaveText(/001$/);
    }
  }
}

for (const action of ['portal', 'overage'] as const) {
  for (const transition of ['B', 'B-A', 'logout', 'unmount'] as const) {
    test(`${action}: late success is ignored after ${transition}`, async ({ page }) => {
      const { navigations } = await prepare(page);
      const delayed = await delayAction(page, action, { url: stripeUrl(action) });
      await actionButton(page, action).click();
      await expect.poll(() => delayed.calls.length).toBe(1);
      await switchAccount(page, transition);
      await finishDelayed(page, action, delayed.release);
      expect(navigations).toEqual([]);
      await expect(page).toHaveURL(`${origin}${harnessPath}`);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      if (transition === 'B' || transition === 'B-A') {
        await expect(actionButton(page, 'portal')).toBeEnabled();
        await expect(actionButton(page, 'overage')).toBeEnabled();
      }
    });
  }

  test(`${action}: a late failure cannot notify a different account`, async ({ page }) => {
    const { navigations } = await prepare(page);
    const delayed = await delayAction(page, action, { error: 'fixture unavailable' }, 503);
    await actionButton(page, action).click();
    await expect.poll(() => delayed.calls.length).toBe(1);
    await switchAccount(page, 'B');
    await finishDelayed(page, action, delayed.release);
    expect(navigations).toEqual([]);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await expect(actionButton(page, action)).toBeEnabled();
  });

  test(`${action}: double click submits one request and locks both billing actions`, async ({ page }) => {
    await prepare(page);
    const delayed = await delayAction(page, action, { error: 'fixture unavailable' }, 503);
    await actionButton(page, action).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => delayed.calls.length).toBe(1);
    await expect(actionButton(page, 'portal')).toBeDisabled();
    await expect(actionButton(page, 'overage')).toBeDisabled();
    await finishDelayed(page, action, delayed.release);
    expect(delayed.calls).toHaveLength(1);
    await expect(actionButton(page, 'portal')).toBeEnabled();
    await expect(actionButton(page, 'overage')).toBeEnabled();
  });

  test(`${action}: deadline unlocks the UI and its late URL cannot navigate`, async ({ page }) => {
    const { navigations } = await prepare(page);
    await page.clock.install();
    const delayed = await delayAction(page, action, { url: stripeUrl(action) });
    await actionButton(page, action).click();
    await expect.poll(() => delayed.calls.length).toBe(1);
    await page.clock.fastForward(20_001);
    await expect(actionButton(page, 'portal')).toBeEnabled();
    await expect(actionButton(page, 'overage')).toBeEnabled();
    await expect(page.getByText('La facturation met trop de temps à répondre. Réessaie dans un instant.', { exact: true })).toBeVisible();
    await finishDelayed(page, action, delayed.release, true);
    expect(navigations).toEqual([]);
    await expect(page).toHaveURL(`${origin}${harnessPath}`);
  });

  test(`${action}: its own HTTPS Stripe destination is accepted`, async ({ page }) => {
    const { navigations } = await prepare(page);
    await routeAction(page, action, route => json(route, { url: stripeUrl(action) }));
    await actionButton(page, action).click();
    await expect.poll(() => navigations).toEqual([stripeUrl(action)]);
  });

  const hostname = action === 'portal' ? 'billing.stripe.com' : 'checkout.stripe.com';
  const rejected = [
    ['other Stripe action', stripeUrl(action === 'portal' ? 'overage' : 'portal')],
    ['HTTP', `http://${hostname}/fixture`],
    ['credentials', `https://user:password@${hostname}/fixture`],
    ['nonstandard port', `https://${hostname}:444/fixture`],
    ['lookalike hostname', `https://${hostname}.example.invalid/fixture`],
  ];
  for (const [label, url] of rejected) {
    test(`${action}: rejects ${label} before navigation`, async ({ page }) => {
      const { navigations } = await prepare(page);
      await routeAction(page, action, route => json(route, { url }));
      await actionButton(page, action).click();
      await expect(page.getByText('URL de facturation non sécurisée', { exact: true })).toBeVisible();
      await expect(actionButton(page, action)).toBeEnabled();
      await drain(page);
      expect(navigations).toEqual([]);
    });
  }
}

test('pack retry retains its intent; another account and a new account lifetime get their own intent', async ({ page }) => {
  await prepare(page);
  const bodies: Array<{ priceId: string; requestId: string }> = [];
  await routeAction(page, 'overage', async route => {
    bodies.push(route.request().postDataJSON());
    await json(route, { error: 'fixture unavailable' }, 503);
  });
  const buy = actionButton(page, 'overage');
  for (let index = 0; index < 2; index++) {
    await buy.click();
    await expect.poll(() => bodies.length).toBe(index + 1);
    await expect(buy).toBeEnabled();
  }
  await switchAccount(page, 'B');
  await buy.click();
  await expect.poll(() => bodies.length).toBe(3);
  await expect(buy).toBeEnabled();
  await page.getByRole('button', { name: 'Compte A', exact: true }).click();
  await expect(page.getByTestId('account')).toHaveText(/001$/);
  await buy.click();
  await expect.poll(() => bodies.length).toBe(4);
  expect(bodies[0].requestId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(new Set([bodies[0].requestId, bodies[2].requestId, bodies[3].requestId]).size).toBe(3);
  expect(new Set(bodies.map(body => body.priceId)).size).toBe(1);
});

test('an obsolete pack response cannot unlock or redirect a pending request for the new account', async ({ page }) => {
  const { navigations } = await prepare(page);
  const releases: Array<() => void> = [];
  await routeAction(page, 'overage', async route => {
    const index = releases.length;
    await new Promise<void>(resolve => { releases.push(resolve); });
    await json(route, index === 0 ? { url: stripeUrl('overage') } : { error: 'fixture unavailable' }, index === 0 ? 200 : 503);
  });
  const buy = actionButton(page, 'overage');
  await buy.click();
  await expect.poll(() => releases.length).toBe(1);
  await switchAccount(page, 'B');
  await buy.click();
  await expect.poll(() => releases.length).toBe(2);
  await finishDelayed(page, 'overage', releases[0]);
  await expect(buy).toBeDisabled();
  expect(navigations).toEqual([]);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await finishDelayed(page, 'overage', releases[1]);
  await expect(buy).toBeEnabled();
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
});

test('an unreadable subscription is not presented as free and can be retried', async ({ page }) => {
  const { recoverSubscription, navigations } = await prepare(page, true);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Impossible de vérifier ton abonnement');
  await expect(page.getByText('Aucun abonnement actif', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Tarif indisponible', { exact: true })).toBeVisible();
  recoverSubscription();
  await alert.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(actionButton(page, 'portal')).toBeEnabled();
  await expect(actionButton(page, 'overage')).toBeEnabled();
  expect(navigations).toEqual([]);
});
