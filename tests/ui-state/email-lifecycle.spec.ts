import { expect, test, type Page } from '@playwright/test';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const signature = 'textarea[placeholder^="Ex :"]';
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test.beforeEach(async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.addInitScript(() => {
    localStorage.setItem('tuto-email-agent', '1');
    Object.assign(window, { lifecycleUnhandled: [] as string[] });
    window.addEventListener('unhandledrejection', event => {
      (window as unknown as { lifecycleUnhandled: string[] }).lifecycleUnhandled.push(String(event.reason));
      event.preventDefault();
    });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as unknown as { lifecycleUnhandled: string[] }).lifecycleUnhandled)).toEqual([]);
});

async function waitConfig(page: Page, owner: string, count = 1) {
  await expect.poll(() => page.evaluate(owner => window.uiStateHarness.pending.filter(p =>
    !p.done && p.table === 'email_agent_config' && p.ownerId === owner).length, owner)).toBe(count);
}

async function resolveConfig(page: Page, owner: string, marker: string, connected = false, latest = false) {
  await page.evaluate(({ owner, marker, connected, latest }) => window.uiStateHarness.resolveConfig(
    'email_agent_config', owner, marker,
    connected ? { gmail_email: `${marker.toLowerCase()}@fixture.invalid` } : {}, latest,
  ), { owner, marker, connected, latest });
}

async function switchAndLoad(page: Page, owner: string, marker: string, connected = false) {
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner);
  await waitConfig(page, owner);
  await resolveConfig(page, owner, marker, connected);
}

async function waitWrites(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.uiStateHarness.pendingWrites.length)).toBe(count);
}

test('email settings: A-B-A ignores an old save receipt and retains the current pending save', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=email');
  await waitConfig(page, A); await resolveConfig(page, A, 'FIRST-A');
  await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
  await page.locator(signature).fill('OLD-SAVE-A');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await waitWrites(page, 1);

  await switchAndLoad(page, B, 'PRIVATE-B');
  await switchAndLoad(page, A, 'CURRENT-A');
  await page.locator(signature).fill('CURRENT-DRAFT-A');
  const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
  await save.click(); await waitWrites(page, 2);
  await page.evaluate(() => window.uiStateHarness.resolveWrite(0)); await settle(page);
  await expect(page.getByText('✅ Paramètres enregistrés', { exact: true })).toHaveCount(0);
  await expect(page.locator(signature)).toHaveValue('CURRENT-DRAFT-A');
  await expect(save).toBeDisabled();

  await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  await expect(page.getByText('✅ Paramètres enregistrés', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();
  expect(await page.evaluate(() => window.uiStateHarness.writes.map(write => ({ owner: write.ownerId, signature: write.payload.signature }))))
    .toEqual([{ owner: A, signature: 'OLD-SAVE-A' }, { owner: A, signature: 'CURRENT-DRAFT-A' }]);
});

test('email settings: A-B-A ignores an old disconnect receipt and keeps the new connection', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=email');
  await waitConfig(page, A); await resolveConfig(page, A, 'FIRST-A', true);
  await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Déconnecter', exact: true }).click(); await waitWrites(page, 1);
  await switchAndLoad(page, B, 'PRIVATE-B', true);
  await switchAndLoad(page, A, 'CURRENT-A', true);
  await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();

  await page.evaluate(() => window.uiStateHarness.resolveWrite(0)); await settle(page);
  await expect(page.getByText('Gmail déconnecté', { exact: true })).toHaveCount(0);
  await expect(page.locator(signature)).toHaveValue('CURRENT-A');
  await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Déconnecter', exact: true }).click(); await waitWrites(page, 2);
  await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  await expect(page.getByText('Gmail déconnecté', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connecter un compte Gmail', exact: true })).toBeVisible();
});

test('email dashboard: a rejected initial A load cannot notify the newer A lifetime', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=emailDashboard');
  await waitConfig(page, A);
  await switchAndLoad(page, B, 'PRIVATE-B', true);
  await expect(page.getByText('private-b@fixture.invalid', { exact: true })).toBeVisible();
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), A);
  await waitConfig(page, A, 2); await resolveConfig(page, A, 'CURRENT-A', true, true);
  await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();

  await page.evaluate(owner => window.uiStateHarness.rejectConfig('email_agent_config', owner), A); await settle(page);
  await expect(page.getByText('Erreur de chargement', { exact: true })).toHaveCount(0);
  await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
});

test('email dashboard: an old rejected activation cannot notify a later account lifetime', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=emailDashboard');
  await waitConfig(page, A); await resolveConfig(page, A, 'FIRST-A', true);
  await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
  await page.getByRole('switch').click(); await waitWrites(page, 1);
  await switchAndLoad(page, B, 'PRIVATE-B', true);
  await switchAndLoad(page, A, 'CURRENT-A', true);
  await expect(page.getByText('current-a@fixture.invalid', { exact: true })).toBeVisible();
  await page.evaluate(() => window.uiStateHarness.resolveWrite(0, true)); await settle(page);
  await expect(page.getByText('Impossible de mettre à jour', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('switch')).toBeEnabled();

  await page.getByRole('switch').click(); await waitWrites(page, 2);
  await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  await expect(page.getByText('🤖 Agent activé', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch')).toBeChecked();
});

test('email dashboard: a legacy success query cannot claim an unconnected Gmail account is connected', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=emailDashboard&gmail=connected');
  await waitConfig(page, A); await resolveConfig(page, A, 'UNCONNECTED-A');
  await expect(page.getByRole('button', { name: 'Connecter Gmail', exact: true })).toBeVisible();
  await settle(page);
  expect(await page.evaluate(() => window.uiStateToastHistory())).not.toContain('✅ Gmail connecté !');
  await expect(page.getByText('✅ Gmail connecté !', { exact: true })).toHaveCount(0);
});
