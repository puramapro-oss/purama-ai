import { expect, test, type Page } from '@playwright/test';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const sender = 'input[placeholder="Tissma Dornier"]';
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test.beforeEach(async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  await page.routeWebSocket('**/*', socket => socket.close());
});

async function load(page: Page, owner: string, marker: string) {
  await expect.poll(() => page.evaluate(owner => window.uiStateHarness.pending.filter(request =>
    !request.done && request.table === 'partner_agent_config' && request.ownerId === owner).length, owner)).toBe(1);
  await page.evaluate(({ owner, marker }) => window.uiStateHarness.resolveConfig('partner_agent_config', owner, marker), { owner, marker });
  await expect(page.locator(sender)).toHaveValue(marker);
}
async function switchAndLoad(page: Page, owner: string, marker: string) {
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner);
  await load(page, owner, marker);
}
async function prepare(page: Page) {
  await page.goto('/tests/ui-state/index.html?page=partner');
  await load(page, A, 'FIRST-A');
  await page.evaluate(() => { window.uiStateHarness.deferWrites = true; });
}
async function writes(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.uiStateHarness.pendingWrites.length)).toBe(count);
}
async function expectNoNotifications(page: Page) {
  await settle(page);
  expect(await page.evaluate(() => window.uiStateToastHistory())).toEqual([]);
}

test('partner settings: a late A save cannot restore A data in B or produce a success', async ({ page }) => {
  await prepare(page);
  await page.locator(sender).fill('PRIVATE-SENT-A');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await writes(page, 1);
  await switchAndLoad(page, B, 'CURRENT-B');
  await page.evaluate(() => window.uiStateHarness.resolveWrite(0));
  await expectNoNotifications(page);
  await expect(page.locator(sender)).toHaveValue('CURRENT-B');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await writes(page, 2);
  expect(await page.evaluate(() => window.uiStateHarness.writes[1]))
    .toMatchObject({ ownerId: B, payload: { sender_name: 'CURRENT-B' } });
});

test('partner settings: A-B-A retains the new pending save when the old receipt arrives', async ({ page }) => {
  await prepare(page);
  await page.locator(sender).fill('OLD-A');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await writes(page, 1);
  await switchAndLoad(page, B, 'PRIVATE-B'); await switchAndLoad(page, A, 'NEW-A');
  await page.locator(sender).fill('CURRENT-DRAFT-A');
  const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
  await save.click(); await writes(page, 2);
  await page.evaluate(() => window.uiStateHarness.resolveWrite(0)); await expectNoNotifications(page);
  await expect(page.locator(sender)).toHaveValue('CURRENT-DRAFT-A'); await expect(save).toBeDisabled();
  await page.evaluate(() => window.uiStateHarness.resolveWrite(1));
  await expect(save).toBeEnabled();
  await expect(page.getByText('✅ Paramètres enregistrés', { exact: true })).toBeVisible();
});

test('partner settings: a rejected old save cannot notify the current account', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await writes(page, 1);
  await switchAndLoad(page, B, 'CURRENT-B');
  await page.evaluate(() => window.uiStateHarness.resolveWrite(0, true)); await expectNoNotifications(page);
  await expect(page.locator(sender)).toHaveValue('CURRENT-B');
  await expect(page.getByRole('button', { name: 'Enregistrer', exact: true })).toBeEnabled();
});

test('partner settings: the save receipt preserves a newer unsaved name and timezone', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click(); await writes(page, 1);
  await page.locator(sender).fill('UNSAVED-NEW-NAME');
  await page.getByLabel('Fuseau horaire', { exact: true }).fill('America/New_York');
  await page.evaluate(() => window.uiStateHarness.resolveWrite(0));
  await expect(page.getByRole('button', { name: 'Enregistrer', exact: true })).toBeEnabled();
  await expect(page.locator(sender)).toHaveValue('UNSAVED-NEW-NAME');
  await expect(page.getByLabel('Fuseau horaire', { exact: true })).toHaveValue('America/New_York');
  expect(await page.evaluate(() => window.uiStateHarness.writes[0].payload))
    .toMatchObject({ sender_name: 'FIRST-A', outreach_timezone: 'UTC' });
});

test('partner settings: two synchronous save events produce one pending write', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Enregistrer')!;
    save.click(); save.click();
  });
  await writes(page, 1); await settle(page);
  expect(await page.evaluate(() => window.uiStateHarness.writes.length)).toBe(1);
});
