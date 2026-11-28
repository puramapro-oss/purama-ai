import { test, expect, type Page } from './fixtures';
import type { Plan } from './transport';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/chat/index.html');
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  await expect(page.getByRole('dialog')).toContainText('Décrivez ce que vous souhaitez faire.');
});
const dialog = (page: Page) => page.getByRole('dialog');
async function plans(page: Page, key: string, values: Plan[]) {
  await page.evaluate(({ key, values }) => { window.__chatHarness.plans[key] = values; }, { key, values });
}
async function send(page: Page, text = 'Préparer mon projet') {
  await page.getByRole('textbox', { name: 'Votre message' }).fill(text);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
}
const calls = (page: Page, key: string) => page.evaluate(key => window.__chatHarness.calls.filter(c => c.key === key), key);
async function identify(page: Page, id: string | null) {
  await page.evaluate(id => window.__chatHarness.setIdentity(id ? { id, email: id + '@example.invalid' } : null), id);
  await expect(dialog(page)).toContainText('Décrivez ce que vous souhaitez faire.');
}

test('an unconfirmed message keeps its identity across a retry and requires the exact stored row before inference', async ({ page }) => {
  await identify(page, 'owner');
  await plans(page, 'write', [{ hold: true }, { status: 409, json: { code: '23505', message: 'duplicate key' } }]);
  // The web client leaves retries to the application: one failed reconciliation,
  // followed by a held read only after the user's explicit retry.
  await plans(page, 'messages', [
    { status: 503, json: { code: '', message: 'Read unavailable' } },
    { hold: true },
  ]);
  const prompt = 'Conserver le même tour après la confirmation perdue';
  await send(page, prompt);
  await expect.poll(async () => (await calls(page, 'write')).length).toBe(1);
  const stored: Record<string, unknown> = { ...(await calls(page, 'write'))[0].body, chat_conversations: { user_id: 'owner' } };
  expect(stored.id).toEqual(expect.any(String));
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'write')!.respond({
    status: 503, json: { code: '', message: 'Acknowledgement unavailable' },
  }));
  await expect(dialog(page)).toContainText('Votre demande est conservée');
  const unavailableReads = await calls(page, 'messages');
  expect(unavailableReads.map(call => ({ method: call.method, retryCount: call.retryCount }))).toEqual([
    { method: 'GET', retryCount: 0 },
  ]);
  expect(await calls(page, 'write')).toHaveLength(1);
  expect(await calls(page, 'chatbot')).toHaveLength(0);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect.poll(async () => (await calls(page, 'messages')).length).toBe(2);
  const userWrites = (await calls(page, 'write')).filter(call => call.body.role === 'user');
  expect(userWrites.map(call => call.body.id)).toEqual([stored.id, stored.id]);
  expect(userWrites.map(call => ({ method: call.method, retryCount: call.retryCount }))).toEqual([
    { method: 'POST', retryCount: 0 }, { method: 'POST', retryCount: 0 },
  ]);
  const resumedRead = (await calls(page, 'messages'))[1];
  expect(resumedRead.retryCount).toBe(0);
  const query = new URL(resumedRead.url);
  expect(query.searchParams.get('id')).toBe(`eq.${stored.id}`);
  expect(query.searchParams.get('conversation_id')).toBe(`eq.${stored.conversation_id}`);
  expect(query.searchParams.get('chat_conversations.user_id')).toBe('eq.owner');
  expect(await calls(page, 'chatbot')).toHaveLength(0);
  await page.evaluate(row => window.__chatHarness.pending.find(p => p.key === 'messages')!.respond({ json: [row] }), stored);
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  await expect(dialog(page).getByText(prompt, { exact: true })).toHaveCount(1);
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  expect((await calls(page, 'chatbot'))[0].body.messages).toEqual([{ role: 'user', content: prompt }]);
});

test('an assistant acknowledgement is reconciled without generating another answer', async ({ page }) => {
  await identify(page, 'owner'); await plans(page, 'write', [{ json: [] }, { hold: true }]);
  await plans(page, 'messages', [{ hold: true }]);
  await send(page, 'Conserver la réponse reçue');
  await expect.poll(async () => (await calls(page, 'write')).length).toBe(2);
  const stored: Record<string, unknown> = { ...(await calls(page, 'write'))[1].body, chat_conversations: { user_id: 'owner' } };
  expect(stored.id).toEqual(expect.any(String)); expect(stored.role).toBe('assistant');
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'write')!.respond({
    status: 503, json: { code: '', message: 'Acknowledgement unavailable' },
  }));
  await expect.poll(async () => (await calls(page, 'messages')).length).toBe(1);
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  await page.evaluate(row => window.__chatHarness.pending.find(p => p.key === 'messages')!.respond({ json: [row] }), stored);
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  await expect(dialog(page)).not.toContainText('son enregistrement a échoué');
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  expect(await calls(page, 'write')).toHaveLength(2);
});

test('a late save reconciliation cannot run the old account request', async ({ page }) => {
  await identify(page, 'owner');
  await plans(page, 'write', [{ status: 503, json: { code: '', message: 'Acknowledgement unavailable' } }]);
  await plans(page, 'messages', [{ hold: true }]);
  await send(page, 'Demande du compte précédent');
  await expect.poll(async () => (await calls(page, 'messages')).length).toBe(1);
  const stored: Record<string, unknown> = { ...(await calls(page, 'write'))[0].body, chat_conversations: { user_id: 'owner' } };
  await identify(page, 'other-owner');
  expect((await calls(page, 'messages'))[0].aborted).toBe(true);
  await page.evaluate(row => window.__chatHarness.pending.find(p => p.key === 'messages')!.respond({ json: [row] }), stored);
  await expect(dialog(page)).not.toContainText('Demande du compte précédent');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  expect(await calls(page, 'chatbot')).toHaveLength(0);
  await send(page, 'Demande du nouveau compte');
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  expect((await calls(page, 'chatbot'))[0].body.messages).toEqual([{ role: 'user', content: 'Demande du nouveau compte' }]);
});

test('guest chat uses one model request, no history database calls and no welcome in model context', async ({ page }, testInfo) => {
  await send(page);
  await expect(dialog(page)).toContainText('Réponse vérifiée dans la simulation.');
  await expect(dialog(page)).toHaveCSS('opacity', '1');
  await expect(dialog(page).locator('[role=log] > div').last()).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('chat-desktop.png') });
  expect(await calls(page, 'create')).toHaveLength(0); expect(await calls(page, 'write')).toHaveLength(0);
  const requests = await calls(page, 'chatbot'); expect(requests).toHaveLength(1);
  expect(requests[0].body.messages).toEqual([{ role: 'user', content: 'Préparer mon projet' }]);
  expect(requests[0].body.pageContext).toBe('/');
});

test('two submits in the same browser task admit one request', async ({ page }) => {
  await plans(page, 'chatbot', [{ stream: true, text: 'En cours' }]);
  await page.getByRole('textbox', { name: 'Votre message' }).fill('Une seule demande');
  await dialog(page).locator('form').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: 'Arrêter la réponse' })).toBeVisible();
  expect(await calls(page, 'chatbot')).toHaveLength(1);
});

test('stop aborts the stream, removes partial output and restores the editable request', async ({ page }) => {
  await plans(page, 'chatbot', [{ stream: true, text: 'Fragment provisoire' }]);
  await send(page, 'Ma demande conservée');
  await expect(dialog(page)).toContainText('Fragment provisoire');
  await page.getByRole('button', { name: 'Arrêter la réponse' }).click();
  await expect(dialog(page)).not.toContainText('Fragment provisoire');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toHaveValue('Ma demande conservée');
  expect((await calls(page, 'chatbot'))[0].aborted).toBe(true);
  expect(await calls(page, 'chatbot')).toHaveLength(1);
});

test('stop while saving a completed answer keeps the answer and does not resend', async ({ page }) => {
  await identify(page, 'owner'); await plans(page, 'write', [{ json: [] }, { hold: true }]);
  await send(page, 'Conserver la réponse complète');
  await expect.poll(async () => (await calls(page, 'write')).length).toBe(2);
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  await page.getByRole('button', { name: 'Arrêter la réponse' }).click();
  await expect(dialog(page)).toContainText('La réponse reste disponible ici');
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toHaveValue('');
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'write')!.respond({ json: [] }));
  await expect(dialog(page)).toContainText('Réponse vérifiée');
});

test('logout clears private content and subsequent guest requests never persist it', async ({ page }) => {
  await identify(page, 'owner'); await send(page, 'Contenu privé du compte');
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  const writes = (await calls(page, 'write')).length;
  await identify(page, null);
  await expect(dialog(page)).not.toContainText('Contenu privé du compte');
  await send(page, 'Nouvelle question visiteur');
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  expect(await calls(page, 'write')).toHaveLength(writes);
  expect((await calls(page, 'chatbot'))[1].body.messages).toEqual([
    { role: 'user', content: 'Nouvelle question visiteur' },
  ]);
});

test('a stale response cannot populate a new conversation or unlock a newer request', async ({ page }) => {
  await plans(page, 'chatbot', [{ hold: true }, { stream: true, text: 'Nouvelle réponse' }]);
  await send(page, 'Ancienne demande');
  await expect.poll(async () => (await calls(page, 'chatbot')).length).toBe(1);
  await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
  await send(page, 'Nouvelle demande');
  await expect(dialog(page)).toContainText('Nouvelle réponse');
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'chatbot')!.respond({ text: 'ANCIEN RETOUR TARDIF' }));
  await expect(dialog(page)).not.toContainText('ANCIEN RETOUR TARDIF');
  await expect(page.getByRole('button', { name: 'Arrêter la réponse' })).toBeVisible();
  expect(await calls(page, 'chatbot')).toHaveLength(2);
});

test('account change during conversation creation prevents a subsequent model call', async ({ page }) => {
  await identify(page, 'user-a'); await plans(page, 'create', [{ hold: true }]);
  await send(page, 'Privé utilisateur A');
  await expect.poll(async () => (await calls(page, 'create')).length).toBe(1);
  await identify(page, 'user-b');
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'create')!.respond({ json: { id: 'old-a' } }));
  await expect(dialog(page)).not.toContainText('Privé utilisateur A');
  expect(await calls(page, 'chatbot')).toHaveLength(0);
  await send(page, 'Demande utilisateur B');
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  expect((await calls(page, 'create'))[1].body.user_id).toBe('user-b');
  expect((await calls(page, 'write')).some(c => c.body.conversation_id === 'old-a')).toBe(false);
});

test('failure to save the user message stops before model inference', async ({ page }) => {
  await identify(page, 'owner'); await plans(page, 'write', [{ status: 503 }]);
  await send(page, 'Ne pas perdre ce texte');
  await expect(dialog(page)).toContainText('Votre demande est conservée');
  expect(await calls(page, 'chatbot')).toHaveLength(0);
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toHaveValue('Ne pas perdre ce texte');
});

test('failure to save the answer preserves it without another model request', async ({ page }) => {
  await identify(page, 'owner'); await plans(page, 'write', [{ json: [] }, { status: 503 }]);
  await send(page);
  await expect(dialog(page)).toContainText('son enregistrement a échoué');
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  expect(await calls(page, 'chatbot')).toHaveLength(1);
});

test('retrying a failed model request reuses the confirmed user turn', async ({ page }) => {
  const prompt = 'Reprendre ma demande enregistrée';
  await identify(page, 'owner');
  await plans(page, 'chatbot', [{ status: 503 }, { text: 'Réponse après relance.' }]);
  await send(page, prompt);
  await expect(dialog(page)).toContainText('Votre demande est conservée');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toHaveValue(prompt);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(dialog(page)).toContainText('Réponse après relance.');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  const writes = await calls(page, 'write');
  expect(writes.filter(call => call.body.role === 'user')).toHaveLength(1);
  expect(writes.filter(call => call.body.role === 'assistant')).toHaveLength(1);
  expect(await calls(page, 'create')).toHaveLength(1);
  const requests = await calls(page, 'chatbot');
  expect(requests).toHaveLength(2);
  expect(requests[1].body.messages).toEqual([{ role: 'user', content: prompt }]);
  await expect(dialog(page).getByText(prompt, { exact: true })).toHaveCount(1);
});

test('editing a failed request creates a distinct saved turn', async ({ page }) => {
  await identify(page, 'owner');
  await plans(page, 'chatbot', [{ status: 429 }, { text: 'Réponse à la demande modifiée.' }]);
  await send(page, 'Demande initiale');
  await expect(dialog(page)).toContainText('Limite temporaire');
  await send(page, 'Demande modifiée');
  await expect(dialog(page)).toContainText('Réponse à la demande modifiée.');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  expect((await calls(page, 'write')).filter(call => call.body.role === 'user').map(call => call.body.content))
    .toEqual(['Demande initiale', 'Demande modifiée']);
  expect((await calls(page, 'chatbot'))[1].body.messages).toEqual([
    { role: 'user', content: 'Demande initiale' }, { role: 'user', content: 'Demande modifiée' },
  ]);
});

test('an intentional identical request after success creates a new turn', async ({ page }) => {
  await identify(page, 'owner'); await send(page, 'Même question');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  await send(page, 'Même question');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  const writes = await calls(page, 'write');
  expect(writes.filter(call => call.body.role === 'user')).toHaveLength(2);
  expect(writes.filter(call => call.body.role === 'assistant')).toHaveLength(2);
  expect((await calls(page, 'chatbot'))[1].body.messages).toEqual([
    { role: 'user', content: 'Même question' }, { role: 'assistant', content: 'Réponse vérifiée dans la simulation.' },
    { role: 'user', content: 'Même question' },
  ]);
});

test('retrying a stopped saved turn excludes its partial answer', async ({ page }) => {
  await identify(page, 'owner');
  await plans(page, 'chatbot', [{ stream: true, text: 'Fragment provisoire' }, { text: 'Réponse après arrêt.' }]);
  await send(page, 'Demande interrompue');
  await expect(dialog(page)).toContainText('Fragment provisoire');
  await page.getByRole('button', { name: 'Arrêter la réponse' }).click();
  await expect(dialog(page)).not.toContainText('Fragment provisoire');
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(dialog(page)).toContainText('Réponse après arrêt.');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  const writes = await calls(page, 'write');
  expect(writes.filter(call => call.body.role === 'user')).toHaveLength(1);
  expect(writes.filter(call => call.body.role === 'assistant')).toHaveLength(1);
  expect((await calls(page, 'chatbot'))[1].body.messages).toEqual([{ role: 'user', content: 'Demande interrompue' }]);
});

for (const boundary of ['conversation', 'account']) {
  test(`a failed turn is not reused after changing ${boundary}`, async ({ page }) => {
    await identify(page, 'owner'); await plans(page, 'chatbot', [{ status: 503 }]);
    await send(page, 'Même texte autre contexte');
    await expect(dialog(page)).toContainText('Votre demande est conservée');
    if (boundary === 'conversation') await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
    else await identify(page, 'other-owner');
    await send(page, 'Même texte autre contexte');
    await expect(dialog(page)).toContainText('Réponse vérifiée');
    await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
    expect((await calls(page, 'write')).filter(call => call.body.role === 'user')).toHaveLength(2);
    expect(await calls(page, 'create')).toHaveLength(2);
    expect((await calls(page, 'chatbot'))[1].body.messages).toEqual([{ role: 'user', content: 'Même texte autre contexte' }]);
  });
}

test('retrying a guest turn avoids duplicate context without storing history', async ({ page }) => {
  await plans(page, 'chatbot', [{ status: 503 }]);
  await send(page, 'Demande visiteur');
  await expect(dialog(page)).toContainText('Votre demande est conservée');
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(dialog(page)).toContainText('Réponse vérifiée');
  expect(await calls(page, 'create')).toHaveLength(0); expect(await calls(page, 'write')).toHaveLength(0);
  expect((await calls(page, 'chatbot'))[1].body.messages).toEqual([{ role: 'user', content: 'Demande visiteur' }]);
  await expect(dialog(page).getByText('Demande visiteur', { exact: true })).toHaveCount(1);
});

test('errors stay out of model context and real answers starting with Bienvenue stay in', async ({ page }) => {
  await plans(page, 'chatbot', [{ status: 429 }, { text: 'Bienvenue, voici une réponse réelle.' }, { text: 'Suite' }]);
  await send(page, 'Première question'); await expect(dialog(page)).toContainText('Limite temporaire');
  await send(page, 'Deuxième question'); await expect(dialog(page)).toContainText('Bienvenue, voici une réponse réelle.');
  await send(page, 'Troisième question'); await expect(dialog(page)).toContainText('Suite');
  const requests = await calls(page, 'chatbot');
  expect(JSON.stringify(requests[2].body.messages)).not.toContain('Limite temporaire');
  expect(requests[2].body.messages).toContainEqual({ role: 'assistant', content: 'Bienvenue, voici une réponse réelle.' });
});

test('history uses a single bounded query and stale history messages cannot replace a new chat', async ({ page }) => {
  await identify(page, 'owner');
  await page.getByRole('button', { name: 'Historique des conversations' }).click();
  await expect(page.getByRole('button', { name: /Conversation précédente/ })).toBeVisible();
  const history = await calls(page, 'history'); expect(history).toHaveLength(1);
  const url = new URL(history[0].url); expect(url.searchParams.get('limit')).toBe('10');
  expect(url.searchParams.get('chat_messages.limit')).toBe('1');
  await plans(page, 'messages', [{ hold: true }]);
  await page.getByRole('button', { name: /Conversation précédente/ }).click();
  await expect.poll(async () => (await calls(page, 'messages')).length).toBe(1);
  await page.getByRole('button', { name: 'Nouvelle conversation' }).click();
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'messages')!.respond({ json: [
    { id: 'old', role: 'assistant', content: 'HISTORIQUE TARDIF', created_at: '2026-11-01T00:00:00Z' },
  ] }));
  await expect(dialog(page)).not.toContainText('HISTORIQUE TARDIF');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
});

test('closing the widget aborts its pending response', async ({ page }) => {
  await plans(page, 'chatbot', [{ stream: true, text: 'En cours' }]); await send(page);
  await expect(dialog(page)).toContainText('En cours');
  await page.getByRole('button', { name: "Fermer l'assistant" }).click();
  expect((await calls(page, 'chatbot'))[0].aborted).toBe(true);
});

test('loading a conversation and submitting in the same task cannot overlap', async ({ page }) => {
  await identify(page, 'owner'); await send(page, 'Contexte précédent');
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Votre message' }).fill('Ne pas utiliser l’ancien contexte');
  await page.getByRole('button', { name: 'Historique des conversations' }).click();
  const historyButton = page.getByRole('button', { name: /Conversation précédente/ });
  await expect(historyButton).toBeVisible();
  await plans(page, 'messages', [{ hold: true }]);
  await historyButton.evaluate(button => {
    (button as HTMLButtonElement).click();
    document.querySelector('form')!.requestSubmit();
  });
  await expect(dialog(page)).toContainText('Chargement de la conversation');
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  expect(await calls(page, 'write')).toHaveLength(2);
  await page.evaluate(() => window.__chatHarness.pending.find(p => p.key === 'messages')!.respond({ json: [] }));
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeEnabled();
});

test('mobile controls remain visible and the demo can be stopped', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const box = await dialog(page).boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await expect(dialog(page)).toHaveCSS('opacity', '1');
  await expect(dialog(page).locator('[role=log] > div').last()).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('chat-mobile.png') });
  await page.getByRole('button', { name: "Fermer l'assistant" }).click();
  await plans(page, 'ai-demo', [{ stream: true, text: 'Brouillon provisoire suffisamment long' }]);
  await page.getByRole('textbox', { name: "Décris une situation d'email professionnel" }).fill('Répondre à un client');
  await page.getByRole('button', { name: 'Générer', exact: true }).click();
  await page.getByRole('button', { name: 'Arrêter la rédaction' }).click();
  await expect(page.getByRole('status')).toContainText('Rédaction arrêtée');
  expect((await calls(page, 'ai-demo'))[0].aborted).toBe(true);
});
