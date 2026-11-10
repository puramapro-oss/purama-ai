import { expect, test, type Page } from '@playwright/test';
import { agentFixture } from './fixtures';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const GA = '10000000-0000-4000-8000-000000000001';
const GB = '10000000-0000-4000-8000-000000000002';
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
async function waitQuery(page: Page, table: string, field?: string, value?: string) {
  await expect.poll(() => page.evaluate(({ table, field, value }) => window.asyncHarness.pending.findIndex(p => !p.done && p.table === table && (!field || p.filters[field] === value)), { table, field, value })).toBeGreaterThanOrEqual(0);
  return page.evaluate(({ table, field, value }) => window.asyncHarness.pending.findIndex(p => !p.done && p.table === table && (!field || p.filters[field] === value)), { table, field, value });
}
async function resolveHistory(page: Page, index: number, marker: string) {
  await page.evaluate(({ index, marker }) => {
    const q = window.asyncHarness.pending[index];
    window.asyncHarness.resolveQuery(index, marker ? [{ ...q.filters, id: `history-${index}`, role: 'user', content: marker, created_at: '2026-11-10T00:00:00Z' }] : []);
  }, { index, marker });
  await paint(page);
}
test.beforeEach(async ({ page }) => {
  await page.route('**/*', r => new URL(r.request().url()).origin === 'http://127.0.0.1:4198' ? r.continue() : r.abort('blockedbyclient'));
  await page.routeWebSocket('**/*', socket => socket.close());
});
for (const next of [B, null]) test(`auth: fresh event ${next ?? 'sign-out'} wins over delayed initial session`, async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=auth');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.initialAuth.length)).toBe(1);
  await page.evaluate(id => window.asyncHarness.emitAuth(id), next);
  await expect(page.getByTestId('auth-user')).toHaveText(next ?? 'signed-out');
  await page.evaluate(id => window.asyncHarness.resolveInitialAuth(id), A);
  await paint(page);
  await expect(page.getByTestId('auth-user')).toHaveText(next ?? 'signed-out');
  await expect(page.getByTestId('auth-loading')).toHaveText('false');
});
test('auth: failed initial read leaves loading and remains signed out', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=auth');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.initialAuth.length)).toBe(1);
  await page.evaluate(() => window.asyncHarness.rejectInitialAuth());
  await expect(page.getByTestId('auth-loading')).toHaveText('false');
  await expect(page.getByTestId('auth-user')).toHaveText('signed-out');
});
test('shared agent chat: old history cannot overwrite a new conversation', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html');
  const old = await waitQuery(page, 'agent_chat_history');
  await page.getByRole('button', { name: 'Nouvelle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.asyncHarness.pending.length)).toBe(2);
  await resolveHistory(page, 1, 'CURRENT-HISTORY');
  await resolveHistory(page, old, 'OLD-HISTORY');
  await expect(page.getByText('CURRENT-HISTORY', { exact: true })).toBeVisible();
  await expect(page.getByText('OLD-HISTORY', { exact: true })).toHaveCount(0);
});
test('shared agent chat: old reply cannot enter new conversation or unlock a new send', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html');
  await resolveHistory(page, await waitQuery(page, 'agent_chat_history'), '');
  const input = page.getByPlaceholder('Parle à email…');
  await input.fill('QUESTION-OLD'); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.replies.length)).toBe(1);
  await page.getByRole('button', { name: 'Nouvelle', exact: true }).click();
  await resolveHistory(page, await waitQuery(page, 'agent_chat_history'), '');
  await expect(input).toBeEnabled();
  await input.fill('QUESTION-NEW'); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.replies.length)).toBe(2);
  await page.evaluate(() => window.asyncHarness.resolveReply(0, 'OLD-ANSWER'));
  await paint(page);
  await expect(page.getByText('OLD-ANSWER', { exact: true })).toHaveCount(0);
  await expect(input).toBeDisabled();
  await page.evaluate(() => window.asyncHarness.resolveReply(1, 'NEW-ANSWER'));
  await expect(page.getByText('NEW-ANSWER', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
});
test('shared agent chat: agent change clears draft and refuses old history', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html');
  const old = await waitQuery(page, 'agent_chat_history');
  await page.getByPlaceholder('Parle à email…').fill('EMAIL-PRIVATE-DRAFT');
  await page.evaluate(() => window.asyncHarness.setAgentType('partner'));
  const current = await waitQuery(page, 'agent_chat_history', 'agent_type', 'partner');
  await resolveHistory(page, current, 'PARTNER-CURRENT');
  await resolveHistory(page, old, 'EMAIL-OLD');
  await expect(page.getByPlaceholder('Parle à partner…')).toHaveValue('');
  await expect(page.getByText('PARTNER-CURRENT', { exact: true })).toBeVisible();
  await expect(page.getByText('EMAIL-OLD', { exact: true })).toHaveCount(0);
});
test('creator: late agent load cannot replace the current route', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=creator');
  const old = await waitQuery(page, 'creator_agents', 'id', GA);
  await page.getByRole('link', { name: 'Agent B', exact: true }).click();
  const current = await waitQuery(page, 'creator_agents', 'id', GB);
  await page.evaluate(({ index, agent }) => window.asyncHarness.resolveQuery(index, agent), { index: current, agent: agentFixture(GB, 'CURRENT-B') });
  await expect(page.getByRole('heading', { name: 'CURRENT-B', exact: true })).toBeVisible();
  await page.evaluate(({ index, agent }) => window.asyncHarness.resolveQuery(index, agent), { index: old, agent: agentFixture(GA, 'OLD-A') });
  await paint(page);
  await expect(page.getByRole('heading', { name: 'CURRENT-B', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'OLD-A', exact: true })).toHaveCount(0);
});

test('auth: initial session still loads when there is no newer event', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=auth');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.initialAuth.length)).toBe(1);
  await page.evaluate(id => window.asyncHarness.resolveInitialAuth(id), A);
  await expect(page.getByTestId('auth-user')).toHaveText(A);
  await expect(page.getByTestId('auth-loading')).toHaveText('false');
});

test('auth: initial failure cannot sign out a newer session', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=auth');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.initialAuth.length)).toBe(1);
  await page.evaluate(id => window.asyncHarness.emitAuth(id), B);
  await page.evaluate(() => window.asyncHarness.rejectInitialAuth());
  await paint(page);
  await expect(page.getByTestId('auth-user')).toHaveText(B);
  await expect(page.getByTestId('auth-loading')).toHaveText('false');
});

test('shared agent chat: account changes clear private drafts and history', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html');
  const old = await waitQuery(page, 'agent_chat_history', 'user_id', A);
  await page.getByPlaceholder('Parle à email…').fill('ACCOUNT-A-PRIVATE');
  await page.evaluate(id => window.asyncHarness.setIdentity(id), B);
  const current = await waitQuery(page, 'agent_chat_history', 'user_id', B);
  await resolveHistory(page, current, 'ACCOUNT-B-HISTORY');
  await resolveHistory(page, old, 'ACCOUNT-A-HISTORY');
  await expect(page.getByPlaceholder('Parle à email…')).toHaveValue('');
  await expect(page.getByText('ACCOUNT-B-HISTORY', { exact: true })).toBeVisible();
  await expect(page.getByText('ACCOUNT-A-HISTORY', { exact: true })).toHaveCount(0);
});

test('shared agent chat: refreshing the same identity preserves the draft', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html');
  await resolveHistory(page, await waitQuery(page, 'agent_chat_history'), '');
  await page.getByPlaceholder('Parle à email…').fill('KEEP-MY-DRAFT');
  await page.evaluate(id => window.asyncHarness.setIdentity(id), A);
  await paint(page);
  await expect(page.getByPlaceholder('Parle à email…')).toHaveValue('KEEP-MY-DRAFT');
  expect(await page.evaluate(() => window.asyncHarness.pending.length)).toBe(1);
});

test('shared agent chat: delayed initial history cannot erase a new turn', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html');
  const history = await waitQuery(page, 'agent_chat_history');
  const input = page.getByPlaceholder('Parle à email…');
  await input.fill('MY-NEW-QUESTION'); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.replies.length)).toBe(1);
  await resolveHistory(page, history, '');
  await expect(page.getByText('MY-NEW-QUESTION', { exact: true })).toBeVisible();
  await page.evaluate(() => window.asyncHarness.resolveReply(0, 'MY-NEW-ANSWER'));
  await expect(page.getByText('MY-NEW-ANSWER', { exact: true })).toBeVisible();
});

async function loadCreator(page: Page, id: string, name: string) {
  const index = await waitQuery(page, 'creator_agents', 'id', id);
  await page.evaluate(({ index, agent }) => window.asyncHarness.resolveQuery(index, agent), { index, agent: agentFixture(id, name) });
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return waitQuery(page, 'creator_agent_chats', 'agent_id', id);
}

test('creator: previous history and draft cannot leak into another agent', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=creator');
  const old = await loadCreator(page, GA, 'AGENT-A');
  await page.getByPlaceholder('Parle à AGENT-A…').fill('PRIVATE-A');
  await page.getByRole('link', { name: 'Agent B', exact: true }).click();
  const current = await loadCreator(page, GB, 'AGENT-B');
  await resolveHistory(page, current, 'CURRENT-B');
  await resolveHistory(page, old, 'OLD-A');
  await expect(page.getByPlaceholder('Parle à AGENT-B…')).toHaveValue('');
  await expect(page.getByText('CURRENT-B', { exact: true })).toBeVisible();
  await expect(page.getByText('OLD-A', { exact: true })).toHaveCount(0);
});

test('creator: old reply cannot enter another agent or unlock its current turn', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=creator');
  await resolveHistory(page, await loadCreator(page, GA, 'AGENT-A'), '');
  const oldInput = page.getByPlaceholder('Parle à AGENT-A…');
  await oldInput.fill('QUESTION-A'); await oldInput.press('Enter');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.replies.length)).toBe(1);
  await page.getByRole('link', { name: 'Agent B', exact: true }).click();
  await resolveHistory(page, await loadCreator(page, GB, 'AGENT-B'), '');
  const input = page.getByPlaceholder('Parle à AGENT-B…');
  await expect(input).toBeEnabled();
  await input.fill('QUESTION-B'); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.asyncHarness.replies.length)).toBe(2);
  await page.evaluate(() => window.asyncHarness.resolveReply(0, 'ANSWER-A'));
  await paint(page);
  await expect(page.getByText('ANSWER-A', { exact: true })).toHaveCount(0);
  await expect(input).toBeDisabled();
  await page.evaluate(() => window.asyncHarness.resolveReply(1, 'ANSWER-B'));
  await expect(page.getByText('ANSWER-B', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
});

test('creator: load failure offers a retry that can recover', async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=creator');
  const index = await waitQuery(page, 'creator_agents', 'id', GA);
  await page.evaluate(index => window.asyncHarness.resolveQuery(index, null, 'Fixture unavailable'), index);
  await expect(page.getByRole('alert')).toHaveText(/Impossible de charger cet agent/);
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await loadCreator(page, GA, 'RECOVERED');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const operation of ['save', 'delete']) test(`creator: late ${operation} cannot replace or leave the current agent`, async ({ page }) => {
  await page.goto('/tests/async-ui/index.html?kind=creator');
  await resolveHistory(page, await loadCreator(page, GA, 'AGENT-A'), '');
  await page.getByRole('tab', { name: 'Paramètres', exact: true }).click();
  if (operation === 'delete') page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: operation === 'save' ? /Enregistrer/ : /Supprimer/ }).click();
  const pending = await waitQuery(page, 'creator_agents', 'id', GA);
  await page.getByRole('link', { name: 'Agent B', exact: true }).click();
  await loadCreator(page, GB, 'CURRENT-B');
  await page.evaluate(({ index, agent }) => window.asyncHarness.resolveQuery(index, agent), { index: pending, agent: agentFixture(GA, 'OLD-SAVED-A') });
  await paint(page);
  await expect(page.getByRole('heading', { name: 'CURRENT-B', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'OLD-SAVED-A', exact: true })).toHaveCount(0);
});
