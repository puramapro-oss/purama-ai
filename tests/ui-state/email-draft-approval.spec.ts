import { expect, test, type Page } from '@playwright/test';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const logId = '00000000-0000-4000-8000-000000000011';
const approvalId = '00000000-0000-4000-8000-000000000021';
const actionId = '00000000-0000-4000-8000-000000000031';
const log = { id: logId, user_id: owner, gmail_message_id: 'parent-1', gmail_thread_id: 'thread-1',
  gmail_draft_id: 'draft-1', from_email: 'recipient@example.invalid', from_name: 'Client Fixture',
  to_email: 'owner@example.invalid', subject: 'Objet reçu de la fixture', snippet: 'Message reçu',
  body_preview: 'Message reçu de la fixture', received_at: '2026-01-01T00:00:00Z', category: 'normal',
  intention: null, sentiment: null, urgency_score: null, tags: [], action_taken: 'draft',
  ai_response: 'ANCIEN TEXTE DE LA LISTE', ai_subject: 'ANCIEN OBJET', ai_reasoning: null,
  confidence_score: null, user_approved: null, user_feedback: null, feedback_at: null,
  tokens_used: null, processing_time_ms: null, error_message: null, created_at: '2026-01-01T00:00:00Z' };
const body = 'Texte exact à envoyer. '.repeat(2000) + '\nFIN DU TEXTE APPROUVÉ <img src=x onerror=alert(1)>';
const preview = { ok: true, status: 'ready', approval_id: approvalId, user_id: owner, log_id: logId,
  expires_at: new Date(Date.now() + 600_000).toISOString(), payload: {
    gmail_email: 'owner@example.invalid', recipient: 'recipient@example.invalid', subject: 'Objet serveur exact',
    body, gmail_message_id: 'parent-1', gmail_thread_id: 'thread-1', gmail_draft_id: 'draft-1',
  } };
const approved = { ok: true, status: 'approved', approval_id: approvalId, user_id: owner, log_id: logId };
const sent = { ok: true, status: 'sent', action_id: actionId, provider_message_id: 'fixture-provider-receipt', matches_current_preview: true };
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test.beforeEach(async ({ page }, testInfo) => {
  const origin = new URL(String(testInfo.project.use.baseURL)).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.goto('/tests/ui-state/index.html?page=emailLogs');
  await expect(page.getByRole('heading', { name: 'Activité de l\'agent' })).toBeVisible();
  await page.evaluate(({ row, other }) => {
    window.uiStateHarness.emailLogs = [row]; window.uiStateHarness.setIdentity(other);
  }, { row: log, other });
  await settle(page);
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner);
  await expect(page.getByText(log.subject, { exact: true })).toBeVisible();
});

async function count(page: Page, expected: number) {
  await expect.poll(() => page.evaluate(() => window.uiStateHarness.emailCalls.length)).toBe(expected);
}
async function resolve(page: Page, index: number, value: unknown) {
  await page.evaluate(({ index, value }) => window.uiStateHarness.resolveEmail(index, value), { index, value });
}
async function open(page: Page) {
  await page.getByRole('button').filter({ hasText: log.subject }).click();
  return page.getByRole('dialog');
}
async function ready(page: Page) {
  const dialog = await open(page); await count(page, 1); await resolve(page, 0, preview);
  await expect(dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true })).toBeEnabled();
  return dialog;
}

test('approval displays the full server version and double clicks send only that version once', async ({ page }) => {
  const dialog = await ready(page);
  const region = dialog.getByRole('region', { name: 'Aperçu à approuver' });
  await expect(region).toContainText('owner@example.invalid');
  await expect(region).toContainText('recipient@example.invalid');
  await expect(region).toContainText('Objet serveur exact');
  await expect(region).toContainText('FIN DU TEXTE APPROUVÉ');
  await expect(region.locator('img')).toHaveCount(0);
  await expect(dialog.getByText('ANCIEN TEXTE DE LA LISTE', { exact: true })).toHaveCount(0);
  await dialog.getByPlaceholder('Ce qui était bien ou ce qu\'il faut améliorer…').fill('Je valide ce texte');
  await dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await count(page, 2);
  expect(await page.evaluate(() => window.uiStateHarness.writes)).toEqual([]);
  await resolve(page, 1, approved); await count(page, 3);
  await resolve(page, 2, sent);
  await expect(page.getByText('Envoi confirmé par Gmail', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.map(call => call.body))).toEqual([
    { action: 'preview', user_id: owner, log_id: logId },
    { action: 'approve', user_id: owner, log_id: logId, approval_id: approvalId, feedback: 'Je valide ce texte' },
    { action: 'send', user_id: owner, log_id: logId, approval_id: approvalId },
  ]);
});

test('an unknown outcome leaves send disabled and offers explicit reconciliation without retry', async ({ page }) => {
  const dialog = await ready(page);
  await dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true }).click();
  await count(page, 2); await resolve(page, 1, approved); await count(page, 3);
  await resolve(page, 2, { ok: false, status: 'unknown' });
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.uiStateToastHistory())).not.toContain('Envoi confirmé par Gmail');
  await dialog.getByRole('button', { name: 'Vérifier le résultat dans Gmail', exact: true }).click();
  await count(page, 4); await resolve(page, 3, { ...sent, reconciled: true, matches_current_preview: true });
  await expect(dialog.getByRole('status')).toContainText('Envoi confirmé dans Gmail');
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.filter(call => call.body.action === 'send').length)).toBe(1);
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.at(-1)?.name)).toBe('email-agent-reconcile-draft');
});

test('a concurrent edit while sending is shown as the approved predecessor sent, never the current draft', async ({ page }) => {
  const dialog = await ready(page);
  await dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true }).click();
  await count(page, 2); await resolve(page, 1, approved); await count(page, 3);
  await resolve(page, 2, { ...sent, matches_current_preview: false });
  await expect(dialog.getByRole('status')).toContainText('Le contenu approuvé a été envoyé ; le brouillon actuel est différent');
  await expect(dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.uiStateToastHistory())).not.toContain('Envoi confirmé par Gmail');
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.filter(call => call.body.action === 'send').length)).toBe(1);
});

test('reconciliation of an older send never labels different current text as newly sent', async ({ page }) => {
  const dialog = await ready(page);
  await dialog.getByRole('button', { name: 'Vérifier le résultat dans Gmail', exact: true }).click();
  await count(page, 2); await resolve(page, 1, { ...sent, reconciled: true, matches_current_preview: false });
  await expect(dialog.getByRole('status')).toContainText('Envoi précédent confirmé ; le brouillon actuel est différent');
  await expect(dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.filter(call => call.body.action === 'send'))).toEqual([]);
  expect(await page.evaluate(() => window.uiStateToastHistory())).not.toContain('Envoi confirmé par Gmail');
});

test('closing the dialog during approval prevents a late approval from starting a send', async ({ page }) => {
  const dialog = await ready(page);
  await dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true }).click();
  await count(page, 2); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await resolve(page, 1, approved); await settle(page);
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.length)).toBe(2);
  expect(await page.evaluate(() => window.uiStateToastHistory())).not.toContain('Envoi confirmé par Gmail');
});

test('A-B-A navigation ignores a late preview from the earlier A lifetime', async ({ page }) => {
  await open(page); await count(page, 1);
  await page.evaluate(other => window.uiStateHarness.setIdentity(other), other); await settle(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner); await settle(page);
  const dialog = await open(page); await count(page, 2);
  await resolve(page, 1, { ...preview, payload: { ...preview.payload, body: 'VERSION COURANTE A' } });
  await expect(dialog).toContainText('VERSION COURANTE A');
  await resolve(page, 0, { ...preview, payload: { ...preview.payload, body: 'VERSION PRIVÉE PÉRIMÉE A' } });
  await settle(page); await expect(dialog).not.toContainText('VERSION PRIVÉE PÉRIMÉE A');
  await expect(dialog).toContainText('VERSION COURANTE A');
});

test('A-B-A navigation cannot reuse an old approved response to send in the new lifetime', async ({ page }) => {
  const dialog = await ready(page);
  await dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true }).click(); await count(page, 2);
  await page.evaluate(other => window.uiStateHarness.setIdentity(other), other); await settle(page);
  await page.evaluate(owner => window.uiStateHarness.setIdentity(owner), owner); await settle(page);
  await resolve(page, 1, approved); await settle(page);
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.filter(call => call.body.action === 'send'))).toEqual([]);
  expect(await page.evaluate(() => window.uiStateToastHistory())).not.toContain('Envoi confirmé par Gmail');
});

test('an expired preview cannot start approval', async ({ page }) => {
  const dialog = await open(page); await count(page, 1);
  await resolve(page, 0, { ...preview, expires_at: '2020-01-01T00:00:00Z' });
  await dialog.getByRole('button', { name: 'Approuver & envoyer', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('expiré');
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.length)).toBe(1);
});

test('reject persists the owner scope without any approval or send request', async ({ page }) => {
  const dialog = await ready(page);
  await dialog.getByRole('button', { name: 'Rejeter', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.uiStateHarness.writes.map(write => ({ owner: write.ownerId, approved: write.payload.user_approved }))))
    .toEqual([{ owner, approved: false }]);
  expect(await page.evaluate(() => window.uiStateHarness.emailCalls.length)).toBe(1);
});
