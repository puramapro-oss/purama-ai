import { expect, test, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', headers: {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
  }, body: JSON.stringify(data) });
}
async function prepare(page: Page, used = true) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (route.request().method() === 'OPTIONS') return json(route, null);
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: used, trial_ends_at: null });
    return json(route, []);
  });
  await page.goto('/tests/quality/billing-scope-harness.html');
  const plan = page.getByRole('heading', { name: 'Starter', exact: true }).locator('..');
  return plan.getByRole('button', { name: used ? "S'abonner" : 'Essai 14 jours, sans carte', exact: true });
}

test('a retry reuses its checkout intent and a different offer gets a new one', async ({ page }) => {
  const bodies: Array<{ priceId: string; requestId: string }> = [];
  const checkout = await prepare(page);
  await page.route('**/functions/v1/create-checkout', async route => {
    bodies.push(route.request().postDataJSON());
    await json(route, { error: 'fixture unavailable' }, 503);
  });
  await checkout.click();
  await expect(checkout).toBeEnabled();
  await checkout.click();
  await expect(checkout).toBeEnabled();
  await page.getByRole('button', { name: /^Annuel/ }).click();
  await checkout.click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2].requestId).not.toBe(bodies[0].requestId);
  expect(bodies[2].priceId).not.toBe(bodies[0].priceId);
});

for (const action of ['checkout', 'trial'] as const) {
  for (const switchBack of [false, true]) {
    test(`${action}: late success is ignored after ${switchBack ? 'A to B to A' : 'sign out'}`, async ({ page }) => {
      const button = await prepare(page, action === 'checkout');
      const navigations: string[] = [];
      await page.route('https://checkout.stripe.com/**', route => { navigations.push(route.request().url()); return route.abort(); });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let arrived = false;
      let delivered = false;
      const path = action === 'checkout' ? '**/functions/v1/create-checkout' : '**/rest/v1/rpc/start_trial';
      await page.route(path, async route => {
        arrived = true;
        await gate;
        await json(route, action === 'checkout' ? { url: 'https://checkout.stripe.com/c/pay/late_fixture' } : null);
        delivered = true;
      });
      await button.click();
      await expect.poll(() => arrived).toBe(true);
      if (switchBack) {
        await page.getByRole('button', { name: 'Compte B', exact: true }).click();
        await expect(page.getByTestId('account')).toHaveText(/002$/);
        await page.getByRole('button', { name: 'Compte A', exact: true }).click();
        await expect(page.getByTestId('account')).toHaveText(/001$/);
      } else {
        await page.getByRole('button', { name: 'Déconnexion fixture' }).click();
        await expect(page.getByTestId('account')).toHaveText('signed-out');
      }
      const finished = page.waitForEvent('requestfinished', { predicate: request => request.method() === 'POST' && request.url().endsWith(action === 'checkout' ? '/create-checkout' : '/start_trial') });
      release();
      await finished;
      await expect.poll(() => delivered).toBe(true);
      // Drain network + React tasks after the actual delayed response, without a timing guess.
      await page.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(requestAnimationFrame); });
      await expect(page).toHaveURL(`${origin}/tests/quality/billing-scope-harness.html`);
      expect(navigations).toEqual([]);
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Starter', exact: true }).locator('..').getByRole('button')).toBeEnabled();
    });
  }
}

test('a hung checkout releases the button at the UI deadline and ignores its late URL', async ({ page }) => {
  const button = await prepare(page);
  await page.clock.install();
  const navigations: string[] = [];
  await page.route('https://checkout.stripe.com/**', route => { navigations.push(route.request().url()); return route.abort(); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived = false;
  await page.route('**/functions/v1/create-checkout', async route => {
    arrived = true;
    await gate;
    await json(route, { url: 'https://checkout.stripe.com/c/pay/too_late' });
  });
  await button.click();
  await expect.poll(() => arrived).toBe(true);
  await page.clock.fastForward(20_001);
  await expect(button).toBeEnabled();
  await expect(page.getByText('Le paiement met trop de temps à répondre. Réessaie dans un instant.')).toBeVisible();
  const finished = page.waitForEvent('requestfinished', { predicate: request => request.method() === 'POST' && request.url().endsWith('/create-checkout') });
  release();
  await finished;
  await page.clock.runFor(50);
  expect(navigations).toEqual([]);
  await expect(page).toHaveURL(`${origin}/tests/quality/billing-scope-harness.html`);
});
