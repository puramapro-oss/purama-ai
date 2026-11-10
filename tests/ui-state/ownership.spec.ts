import { expect, test, type Page } from '@playwright/test';
import type { SettingsTable } from './fixtures';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const SA = '10000000-0000-4000-8000-000000000001';
const SB = '10000000-0000-4000-8000-000000000002';
const settings = [
  { kind: 'partner', table: 'partner_agent_config', field: 'sender_name', selector: 'input[placeholder="Tissma Dornier"]' },
  { kind: 'email', table: 'email_agent_config', field: 'signature', selector: 'textarea[placeholder^="Ex :"]' },
  { kind: 'compta', table: 'compta_agent_config', field: 'company_name', selector: 'input[placeholder="SASU PURAMA"]' },
] as const;

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:4197'
    ? route.continue() : route.abort('blockedbyclient'));
  await page.routeWebSocket('**/*', socket => socket.close());
});
async function waitConfig(page: Page, table: SettingsTable, owner: string) {
  await expect.poll(() => page.evaluate(({ table, owner }) =>
    window.uiStateHarness.pending.filter(p => !p.done && p.table === table && p.ownerId === owner).length,
  { table, owner })).toBe(1);
}
async function config(page: Page, table: SettingsTable, owner: string, marker: string) {
  await waitConfig(page, table, owner);
  await page.evaluate(({ table, owner, marker }) => window.uiStateHarness.resolveConfig(table, owner, marker), { table, owner, marker });
}
async function identity(page: Page, owner: string) {
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner);
}
async function history(page: Page, session: string, content: string) {
  await expect.poll(() => page.evaluate(session => window.uiStateHarness.pending.filter(p => !p.done && p.sessionId === session).length, session)).toBe(1);
  await page.evaluate(({ session, owner, content }) => window.uiStateHarness.resolveHistory(session, owner, content), { session, owner: A, content });
}
for (const { kind, table, field, selector } of settings) {
  test(`${kind}: account switch never saves A's settings as B; same-account refresh preserves draft`, async ({ page }, testInfo) => {
    await page.goto(`/tests/ui-state/index.html?page=${kind}`);
    await config(page, table, A, 'PRIVATE-A');
    await expect(page.locator(selector)).toHaveValue('PRIVATE-A');
    await identity(page, B);
    await waitConfig(page, table, B);
    const save = page.getByRole('button', { name: 'Enregistrer', exact: true });
    if (await save.isVisible() && await save.isEnabled()) await save.click();
    const writesBeforeBLoaded = await page.evaluate(() => window.uiStateHarness.writes);
    await testInfo.attach('writes-before-account-B-loaded', { body: JSON.stringify(writesBeforeBLoaded, null, 2), contentType: 'application/json' });
    expect.soft(writesBeforeBLoaded.filter(w => w.ownerId === B), 'No A payload may be sent with B identity').toEqual([]);
    expect.soft(await page.locator(selector).count(), 'A form is removed while B loads').toBe(0);
    await config(page, table, B, 'PRIVATE-B');
    await expect(page.locator(selector)).toHaveValue('PRIVATE-B');
    await page.locator(selector).fill('DRAFT-B');
    await identity(page, B);
    await expect(page.locator(selector)).toHaveValue('DRAFT-B');
    await save.click();
    const writes = await page.evaluate(() => window.uiStateHarness.writes);
    const last = writes.at(-1)!;
    expect(last.ownerId).toBe(B);
    expect(last.payload[field]).toBe('DRAFT-B');
    expect(writes.filter(w => w.ownerId === B).some(w => JSON.stringify(w.payload).includes('PRIVATE-A'))).toBe(false);
  });
  test(`${kind}: late A config cannot overwrite loaded B`, async ({ page }) => {
    await page.goto(`/tests/ui-state/index.html?page=${kind}`);
    await waitConfig(page, table, A);
    await identity(page, B);
    await config(page, table, B, 'PRIVATE-B');
    await expect(page.locator(selector)).toHaveValue('PRIVATE-B');
    await config(page, table, A, 'LATE-PRIVATE-A');
    await expect(page.locator(selector)).toHaveValue('PRIVATE-B');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    const last = await page.evaluate(() => window.uiStateHarness.writes.at(-1));
    expect(last?.ownerId).toBe(B);
    expect(last?.payload[field]).toBe('PRIVATE-B');
  });
}
test('legal: late history A cannot replace selected conversation B', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=legal');
  await page.getByRole('button', { name: 'Conversation A', exact: true }).click();
  await page.getByRole('button', { name: 'Conversation B', exact: true }).click();
  await history(page, SB, 'CURRENT-HISTORY-B');
  await expect(page.getByText('CURRENT-HISTORY-B', { exact: true })).toBeVisible();
  await history(page, SA, 'LATE-HISTORY-A');
  await expect(page.getByText('CURRENT-HISTORY-B', { exact: true })).toBeVisible();
  await expect(page.getByText('LATE-HISTORY-A', { exact: true })).toHaveCount(0);
});
test('legal: new conversation stays empty after old history resolves', async ({ page }) => {
  await page.goto('/tests/ui-state/index.html?page=legal');
  await page.getByRole('button', { name: 'Conversation A', exact: true }).click();
  await page.getByRole('button', { name: 'Nouvelle', exact: true }).click();
  await history(page, SA, 'LATE-HISTORY-A');
  await expect(page.getByText('LATE-HISTORY-A', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Pose ta question juridique', { exact: true })).toBeVisible();
});
