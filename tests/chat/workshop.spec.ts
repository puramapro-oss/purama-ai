import { test, expect, type Page } from './fixtures';

const list = { ok: true, projects: [{ id: 'restaurant', name: 'Restaurant', ready: true, maxParallel: 2 }], missions: [] };
const mission = {
  id: '00000000-0000-4000-8000-000000000010', projectId: 'restaurant', title: 'Création préparée depuis la conversation', state: 'paused',
  createdAt: '2026-11-24T12:00:00Z', updatedAt: '2026-11-24T12:00:00Z', finishedAt: null,
  verifiedTasks: 0, totalTasks: 1, usage: { tokens: 0, costMicros: 0 },
  tasks: [{ id: '00000000-0000-4000-8000-000000000011', key: 'plan', title: 'Préparer la création', state: 'pending', provider: null, attempt: 0, outputSha: null, evidenceCount: 0 }],
};
const calls = (page: Page, key: string) => page.evaluate(key => window.__chatHarness.calls.filter(call => call.key === key), key);
const goal = (page: Page) => page.getByLabel('Que voulez-vous créer ou améliorer ?');
const prepare = (page: Page) => page.getByRole('button', { name: 'Préparer dans l’atelier' });
let errors: string[];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/chat/index.html');
  await page.evaluate(response => {
    window.__chatHarness.setIdentity({ id: 'alice', email: 'alice@example.invalid' });
    // Strict Mode mounts the destination effects twice; both remain simulated.
    window.__chatHarness.plans['chef-workshop'] = [{ json: response }, { json: response }];
  }, list);
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
});

test.afterEach(async ({ page, browser }, testInfo) => {
  await testInfo.attach('workshop-handoff-runtime', {
    body: Buffer.from(JSON.stringify({ platform: process.platform, browser: browser.browserType().name(), version: browser.version(),
      viewport: page.viewportSize(), simulatedCalls: await page.evaluate(() => window.__chatHarness.calls.map(call => ({ key: call.key, action: call.body.action, aborted: call.aborted }))),
      pageErrors: errors }, null, 2)), contentType: 'application/json',
  });
  expect(errors).toEqual([]);
});

test('conversation to workshop preserves the source, supports another handoff on the mounted route, and starts only the edited request', async ({ page }, testInfo) => {
  const initialGoal = 'Créer un site pour mon restaurant avec menu et réservations.';
  await page.getByRole('textbox', { name: 'Votre message' }).fill(initialGoal);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(page.getByRole('dialog')).toContainText('Réponse vérifiée dans la simulation.');
  await expect(prepare(page)).toBeEnabled();
  await prepare(page).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle création' })).toBeVisible();
  const firstBrief = await goal(page).inputValue();
  expect(firstBrief).toContain(initialGoal);
  expect(firstBrief).toContain('PURA : Réponse vérifiée dans la simulation.');
  expect(firstBrief).not.toContain('Bonjour, je suis PURA');
  expect((await calls(page, 'chef-workshop')).filter(call => call.body.action === 'start')).toHaveLength(0);
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  expect(page.url()).not.toContain(encodeURIComponent(initialGoal));

  await goal(page).fill('Mon brouillon déjà commencé reste ici tant que je ne le remplace pas.');
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  await expect(page.getByRole('log')).toContainText(initialGoal);
  await expect(page.getByRole('log')).toContainText('Réponse vérifiée dans la simulation.');
  const nextGoal = 'Ajouter les réservations pour les grands groupes et une version accessible.';
  await page.getByRole('textbox', { name: 'Votre message' }).fill(nextGoal);
  await prepare(page).click();
  await expect(page.getByRole('region', { name: 'Demande reçue de la conversation' })).toContainText(nextGoal);
  await expect(goal(page)).toHaveValue('Mon brouillon déjà commencé reste ici tant que je ne le remplace pas.');
  await page.getByRole('button', { name: 'Garder ma demande actuelle' }).click();
  await expect(page.getByRole('region', { name: 'Demande reçue de la conversation' })).toHaveCount(0);
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toHaveValue(nextGoal);
  await prepare(page).click();
  await page.getByRole('button', { name: 'Utiliser cette demande' }).click();
  await expect.poll(() => goal(page).inputValue()).toContain(nextGoal);
  const finalGoal = 'Créer la réservation de groupes, accessible au clavier, avec confirmation visible.';
  await goal(page).fill(finalGoal);
  await page.evaluate(response => { window.__chatHarness.plans['chef-workshop'] = [{ json: response }, { json: response }]; }, { ok: true, mission });
  await page.getByRole('button', { name: 'Lancer la création' }).click();
  await expect(page.getByRole('heading', { name: mission.title })).toBeVisible();
  const starts = (await calls(page, 'chef-workshop')).filter(call => call.body.action === 'start');
  expect(starts).toHaveLength(1);
  expect(starts[0].body).toMatchObject({ prompt: finalGoal, projectId: 'restaurant', requestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('conversation-workshop.png'), fullPage: true });
});

test('storage failure uses the fresh account-bound route and changing account clears its private draft', async ({ page }) => {
  await page.evaluate(() => {
    sessionStorage.setItem('purama.workshop.draft.v1', JSON.stringify({ id: crypto.randomUUID(), ownerId: 'alice', createdAt: Date.now(), prompt: 'Ancien brouillon à ne pas ressusciter.' }));
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'purama.workshop.draft.v1') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  const fresh = 'Nouvelle création confidentielle pour le restaurant de Alice.';
  await page.getByRole('textbox', { name: 'Votre message' }).fill(fresh);
  await prepare(page).click();
  await expect.poll(() => goal(page).inputValue()).toContain(fresh);
  expect(await goal(page).inputValue()).not.toContain('Ancien brouillon');
  expect(await calls(page, 'chatbot')).toHaveLength(0);
  await page.evaluate(response => {
    window.__chatHarness.plans['chef-workshop'] = [{ json: response }, { json: response }];
    window.__chatHarness.setIdentity({ id: 'bob', email: 'bob@example.invalid' });
  }, list);
  await expect(goal(page)).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(fresh);
  expect((await calls(page, 'chef-workshop')).filter(call => call.body.action === 'start')).toHaveLength(0);
});

test('landscape keeps preparation and the composer reachable and excludes stopped provisional output', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(() => { window.__chatHarness.plans.chatbot = [{ stream: true, text: 'Fragment provisoire à exclure' }]; });
  const request = 'Préparer un restaurant accessible et réservable depuis le téléphone.';
  await page.getByRole('textbox', { name: 'Votre message' }).fill(request);
  await page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(page.getByRole('log')).toContainText('Fragment provisoire');
  await expect(prepare(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Arrêter la réponse' }).click();
  await expect(prepare(page)).toBeEnabled();
  await prepare(page).scrollIntoViewIfNeeded();
  await expect(prepare(page)).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('textbox', { name: 'Votre message' })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Envoyer le message' })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('conversation-workshop-landscape.png') });
  await prepare(page).press('Enter');
  await expect.poll(() => goal(page).inputValue()).toContain(request);
  expect(await goal(page).inputValue()).not.toContain('Fragment provisoire');
  expect(await goal(page).inputValue()).not.toContain('Réponse arrêtée');
  expect(await calls(page, 'chatbot')).toHaveLength(1);
  expect((await calls(page, 'chef-workshop')).filter(call => call.body.action === 'start')).toHaveLength(0);
});
