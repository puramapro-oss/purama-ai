import { test, expect, type Page } from './fixtures';
import type { Plan } from './transport';
import { catalogFixture, operationFixture, OWNER, OTHER_OWNER } from '../../src/test/consultation-fixtures';
import { SUPER_ADMIN_EMAIL } from '../../src/lib/constants';
import type { ConsultationCatalog, ConsultationInput } from '../../src/lib/consultation-client';

// Real browser, React components and consultation client. Only the external
// authentication and HTTP responses use the existing closed-network harness.
const endpoint = 'iao-consultation';
const main = 'studio/primary@revision-2';
const peer = 'studio/reviewer@revision-3';
const reflections = ['auto', 'standard', 'deep', 'maximum'] as const;
const speeds = ['standard', 'fast', 'ultra_fast'] as const;
function completeCatalog(): ConsultationCatalog {
  const catalog = catalogFixture();
  catalog.models = [main, peer].map(model => ({
    model, provider: 'fixture-provider', reflections: [...reflections], speeds: [...speeds], maxOutputTokens: 16384,
    profiles: reflections.flatMap(reflection => speeds.map(speed => ({ reflection, speed,
      research: { maxSearches: speed === 'ultra_fast' ? 1 : 3, maxPages: speed === 'ultra_fast' ? 2 : 6,
        maxReviewers: speed === 'ultra_fast' ? 0 : 1, maxRounds: 1, concurrency: 2 },
    }))),
  }));
  return catalog;
}
async function queue(page: Page, plans: Plan[]) {
  await page.evaluate(({ endpoint, plans }) => { window.__chatHarness.plans[endpoint] = plans; }, { endpoint, plans });
}
async function catalogue(page: Page, value = completeCatalog()) {
  // StrictMode starts and invalidates the first effect before starting its copy.
  await queue(page, [{ json: { ok: true, catalog: value } }, { json: { ok: true, catalog: value } }]);
}
async function identity(page: Page, kind: 'member' | 'founder' | 'unverified' | 'anonymous', id = OWNER) {
  await page.evaluate(({ kind, id, founder }) => {
    const user = { id, email: kind === 'founder' || kind === 'unverified' ? founder : 'member@example.invalid',
      ...(kind === 'founder' ? { email_confirmed_at: '2026-11-23T10:00:00Z' } : {}),
      ...(kind === 'anonymous' ? { is_anonymous: true } : {}) };
    window.__chatHarness.setIdentity(user);
  }, { kind, id, founder: SUPER_ADMIN_EMAIL });
}
async function openAnalysis(page: Page, kind: 'member' | 'founder' | 'unverified' = 'member', value = completeCatalog()) {
  await identity(page, kind);
  await catalogue(page, value);
  await page.getByRole('button', { name: 'Analyse approfondie', exact: true }).click();
}
const panel = (page: Page) => page.getByRole('region', { name: 'Analyse approfondie PURAMA' });
const calls = (page: Page, action: string) => page.evaluate(({ endpoint, action }) =>
  window.__chatHarness.calls.filter(call => call.key === endpoint && call.body.action === action), { endpoint, action });
async function running(page: Page, question: string, keyboard = false) {
  await queue(page, [{ hold: true }]);
  await page.getByRole('textbox', { name: 'Question de consultation' }).fill(question);
  const send = page.getByRole('button', { name: 'Lancer la consultation' });
  if (keyboard) { await send.focus(); await page.keyboard.press('Enter'); } else await send.click();
  await expect.poll(async () => (await calls(page, 'consult')).length).toBe(1);
  return (await calls(page, 'consult'))[0].body as unknown as ConsultationInput;
}
async function respond(page: Page, input: ConsultationInput, answer: string, partial = false) {
  const operation = operationFixture(input.operationId);
  operation.result!.plan.model = input.preferences.model;
  operation.result!.plan.reflection = input.preferences.reflection === 'auto' ? 'standard' : input.preferences.reflection!;
  operation.result!.plan.speed = input.preferences.speed!;
  operation.result!.answer = answer;
  if (partial) {
    operation.status = 'partial'; operation.result!.status = 'partial'; operation.result!.reason = 'some_calls_unavailable';
  }
  await page.evaluate(({ endpoint, operation }) => {
    window.__chatHarness.pending.find(item => item.key === endpoint)!.respond({ json: { ok: true, operation } });
  }, { endpoint, operation });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/chat/index.html');
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
});

for (const reflection of reflections) for (const speed of speeds) {
  test(`founder consultation preserves ${reflection}/${speed} through browser controls and response`, async ({ page }) => {
    await openAnalysis(page, 'founder');
    await expect(panel(page)).toContainText('Consultation disponible.');
    await page.getByText('Réglages techniques du fondateur', { exact: true }).click();
    const model = reflection === 'deep' ? peer : main;
    await page.getByRole('combobox', { name: 'Modèle principal', exact: true }).selectOption(model);
    await page.getByRole('combobox', { name: 'Réflexion de la consultation' }).selectOption(reflection);
    await page.getByRole('combobox', { name: 'Vitesse de la consultation' }).selectOption(speed);
    const lengths = { auto: 64, standard: 1024, deep: 4096, maximum: 8000 };
    const prompt = ('Projet de qualification navigateur. ').repeat(250).slice(0, lengths[reflection]);
    const request = await running(page, prompt, reflection === 'auto' && speed === 'standard');
    expect(request.question).toBe(prompt.trim());
    expect(request.preferences).toEqual({ model, reflection, speed });
    expect(request.reviewerModels).toEqual([]);
    expect(request.research).toEqual({ queries: [], urls: [] });
    expect(Object.keys(request).filter(key => ['userId', 'budget', 'credentials'].includes(key))).toEqual([]);
    await respond(page, request, `Réponse de transport ${reflection}/${speed}`);
    await expect(panel(page)).toContainText(`Réponse de transport ${reflection}/${speed}`);
    await expect(panel(page)).toContainText(`Modèle : ${model}`);
    await expect(page.getByRole('button', { name: 'Nouvelle consultation' })).toBeEnabled();
    expect(await calls(page, 'consult')).toHaveLength(1);
  });
}

for (const kind of ['member', 'unverified'] as const) {
  test(`${kind} uses the automatic public profile without exposing technical engine controls`, async ({ page }) => {
    await openAnalysis(page, kind);
    await expect(panel(page)).toContainText('Consultation disponible.');
    await expect(panel(page).getByRole('combobox')).toHaveCount(0);
    await expect(panel(page)).not.toContainText('Réglages techniques');
    const request = await running(page, 'Organiser plusieurs étapes de mon projet.');
    expect(request.preferences).toEqual({ model: main, reflection: 'auto', speed: 'standard' });
    expect(request.reviewerModels).toEqual([]);
    await respond(page, request, 'Résultat de transport du parcours public.');
    await expect(panel(page)).toContainText('Résultat de transport du parcours public.');
    await expect(panel(page)).not.toContainText(main);
    await expect(panel(page)).not.toContainText('fixture-provider');
  });
}

test('separates cited evidence from additional retrieved material in the member view', async ({ page }) => {
  await openAnalysis(page);
  const request = await running(page, 'Retrouve les références utilisées.');
  const operation = operationFixture(request.operationId);
  const result = operation.result!;
  result.sources.push({ ...result.sources[0], id: 'source-2', title: 'Document complémentaire',
    url: 'https://example.com/autre', text: '', truncated: true });
  await page.evaluate(({ endpoint, operation }) => {
    window.__chatHarness.pending.find(item => item.key === endpoint)!.respond({ json: { ok: true, operation } });
  }, { endpoint, operation });
  const article = panel(page).getByRole('article', { name: 'Résultat de consultation' });
  await expect(article.getByRole('heading', { name: 'Sources citées (1)' })).toBeVisible();
  await expect(article.getByRole('link', { name: /Une source publique/ })).toBeVisible();
  await expect(article.getByRole('link', { name: /Document complémentaire/ })).toHaveCount(0);
  const more = article.locator('summary', { hasText: 'Sources recueillies sans citation (1)' });
  await more.focus(); await page.keyboard.press('Enter');
  await expect(article.getByRole('link', { name: /Document complémentaire/ })).toBeVisible();
  await expect(article.getByText('Aucun extrait de texte disponible.')).toBeVisible();
  await expect(article.getByText('Titre ou extrait abrégé.')).toBeVisible();
  await expect(article.getByText('La vérification indépendante des faits reste à faire.')).toBeVisible();
  expect(await calls(page, 'consult')).toHaveLength(1);
});

test('member opts into Conseil IAO and submits one consultation with two distinct reviewers', async ({ page }) => {
  const secondPeer = 'studio/second-reviewer@revision-1';
  const catalog = completeCatalog();
  const profileSource = catalog.models[0];
  catalog.models = [main, peer, secondPeer].map(model => ({
    ...profileSource,
    model,
    profiles: profileSource.profiles.map(profile => profile.reflection === 'deep' && profile.speed === 'standard'
      ? { ...profile, research: { ...profile.research, maxReviewers: 2, maxRounds: 2 } }
      : profile),
  }));
  await openAnalysis(page, 'member', catalog);
  const region = panel(page);
  const council = region.getByRole('button', { name: 'Conseil IAO', exact: true });
  await expect(council).toHaveAttribute('aria-pressed', 'false');
  await expect(region.getByRole('combobox')).toHaveCount(0);
  expect(await calls(page, 'consult')).toHaveLength(0);

  const callsBeforeActivation = await page.evaluate(() => window.__chatHarness.calls.length);
  await council.click();
  await expect(council).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__chatHarness.calls.length)).toBe(callsBeforeActivation);
  const question = 'Quelles hypothèses dois-je vérifier avant de tester ces deux options ?';
  const request = await running(page, question);
  expect(request.question).toBe(question);
  expect(request.preferences).toEqual({ model: main, reflection: 'deep', speed: 'standard' });
  expect(request.reviewerModels).toEqual([peer, secondPeer]);
  expect(request.research).toEqual({ queries: [], urls: [] });

  const answer = 'Les deux options dépendent du délai. Mesurez-le avant de choisir.';
  await respond(page, request, answer);
  await expect(region.getByRole('article', { name: 'Résultat de consultation' })).toContainText(answer);
  await expect(region.getByRole('combobox')).toHaveCount(0);
  for (const internalName of [main, peer, secondPeer, profileSource.provider]) {
    await expect(region).not.toContainText(internalName);
  }
  expect(await calls(page, 'consult')).toHaveLength(1);
});

test('visitor and anonymous session cannot open private consultation or send its request', async ({ page }) => {
  await expect(page.getByRole('group', { name: 'Mode de conversation' })).toHaveCount(0);
  await identity(page, 'anonymous');
  await expect(page.getByRole('group', { name: 'Mode de conversation' })).toHaveCount(0);
  expect(await calls(page, 'catalog')).toHaveLength(0);
  expect(await calls(page, 'consult')).toHaveLength(0);
});

test('two consultation submissions in the same browser task admit one operation', async ({ page }) => {
  await openAnalysis(page); await expect(panel(page)).toContainText('Consultation disponible.');
  await queue(page, [{ hold: true }]);
  await page.getByRole('textbox', { name: 'Question de consultation' }).fill('Une seule opération pour ce double clic.');
  await page.getByRole('button', { name: 'Lancer la consultation' }).evaluate(button => {
    (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click();
  });
  await expect.poll(async () => (await calls(page, 'consult')).length).toBe(1);
  const request = (await calls(page, 'consult'))[0].body as unknown as ConsultationInput;
  await respond(page, request, 'Une seule réponse pour une seule opération.');
  await expect(panel(page)).toContainText('Une seule réponse pour une seule opération.');
  expect(await calls(page, 'consult')).toHaveLength(1);
});

test('explicit public research and a chosen reviewer are transmitted without adding private text', async ({ page }) => {
  await openAnalysis(page, 'founder'); await expect(panel(page)).toContainText('Consultation disponible.');
  await page.getByText('Réglages techniques du fondateur', { exact: true }).click();
  await page.getByRole('checkbox', { name: peer }).check();
  await page.getByText('Recherche publique facultative', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Requêtes publiques' }).fill('  sujet public A  \n\n公开主题 B');
  await page.getByRole('textbox', { name: 'Pages HTTPS' }).fill('https://example.com/a\nhttps://example.com/b');
  const request = await running(page, 'Détail privé de qualification présent seulement dans la question.');
  expect(request.reviewerModels).toEqual([peer]);
  expect(request.research).toEqual({ queries: ['sujet public A', '公开主题 B'], urls: ['https://example.com/a', 'https://example.com/b'] });
  expect(JSON.stringify(request.research)).not.toContain('Détail privé');
  await respond(page, request, 'Résultat simulé de la recherche explicitement choisie.');
  await expect(panel(page)).toContainText('Résultat simulé de la recherche explicitement choisie.');
  expect(await calls(page, 'consult')).toHaveLength(1);
});

test('selected reviewers survive a restrictive profile change and block submission until explicitly removed', async ({ page }) => {
  await openAnalysis(page, 'founder');
  await expect(panel(page)).toContainText('Consultation disponible.');
  await page.getByText('Réglages techniques du fondateur', { exact: true }).click();
  await page.getByRole('checkbox', { name: peer }).check();
  await page.getByRole('textbox', { name: 'Question de consultation' }).fill('Conserver le choix utilisateur.');
  await page.getByRole('combobox', { name: 'Vitesse de la consultation' }).selectOption('ultra_fast');
  await expect(page.getByRole('checkbox', { name: peer })).toBeChecked();
  await expect(panel(page)).toContainText('Ce profil autorise 0 avis supplémentaires.');
  await expect(page.getByRole('button', { name: 'Lancer la consultation' })).toBeDisabled();
  expect(await calls(page, 'consult')).toHaveLength(0);
  await page.getByRole('checkbox', { name: peer }).uncheck();
  const request = await running(page, 'Continuer sans avis supplémentaire.');
  expect(request.reviewerModels).toEqual([]);
  expect(request.preferences.speed).toBe('ultra_fast');
  await respond(page, request, 'Choix ajusté explicitement.');
  await expect(panel(page)).toContainText('Choix ajusté explicitement.');
});

test('combined UTF-8 overflow is visible before any consultation leaves the browser', async ({ page }) => {
  await openAnalysis(page, 'founder');
  await expect(panel(page)).toContainText('Consultation disponible.');
  await page.getByRole('textbox', { name: 'Question de consultation' }).fill('界'.repeat(8000));
  await page.getByText('Recherche publique facultative', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Pages HTTPS' }).fill(Array.from({ length: 6 }, (_, i) => `https://example.com/${i}/${'a'.repeat(8000)}`).join('\n'));
  await expect(panel(page)).toContainText('L’ensemble de la question et des recherches est trop volumineux.');
  await expect(page.getByRole('button', { name: 'Lancer la consultation' })).toBeDisabled();
  expect(await calls(page, 'consult')).toHaveLength(0);
  expect(await page.evaluate(owner => sessionStorage.getItem(`purama.consultation.pending.${owner}`), OWNER)).toBeNull();
});

test('closing and reopening a pending consultation recovers status without resending the question', async ({ page }) => {
  await openAnalysis(page); await expect(panel(page)).toContainText('Consultation disponible.');
  const request = await running(page, 'Question en attente à conserver.');
  await page.getByRole('button', { name: "Fermer l'assistant" }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await calls(page, 'consult'))[0].aborted).toBe(true);
  await respond(page, request, 'Réponse tardive de la fenêtre fermée.');
  await catalogue(page);
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  await expect(panel(page)).toContainText('L’état de cette demande reste à confirmer.');
  await expect(panel(page)).toContainText('Consultation disponible.');
  await expect(panel(page)).not.toContainText('Réponse tardive de la fenêtre fermée.');
  const operation = operationFixture(request.operationId); operation.result!.answer = 'Réponse récupérée par lecture de statut.';
  await queue(page, [{ json: { ok: true, operation } }]);
  await page.getByRole('button', { name: 'Actualiser l’état' }).click();
  await expect(panel(page)).toContainText('Réponse récupérée par lecture de statut.');
  expect(await calls(page, 'consult')).toHaveLength(1);
  expect((await calls(page, 'status'))[0].body.operationId).toBe(request.operationId);
});

test('browser reload preserves only the pending UUID after a malformed upstream error and recovers through status', async ({ page }) => {
  await openAnalysis(page); await expect(panel(page)).toContainText('Consultation disponible.');
  // The existing transport deliberately returns a text/plain error here. Even
  // an invalid response cannot prove that the remote operation was not started.
  await queue(page, [{ status: 503, json: { code: 'IAO_UNAVAILABLE' } }]);
  await page.getByRole('textbox', { name: 'Question de consultation' }).fill('Contenu privé de test non stocké dans le navigateur.');
  await page.getByRole('button', { name: 'Lancer la consultation' }).click();
  await expect(panel(page)).toContainText('Les données de consultation sont invalides.');
  const request = (await calls(page, 'consult'))[0].body;
  const retained = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  expect(retained).toEqual({ [`purama.consultation.pending.${OWNER}`]: request.operationId });
  await page.reload();
  await page.getByRole('button', { name: "Ouvrir l'assistant PURA" }).click();
  await openAnalysis(page); await expect(panel(page)).toContainText('L’état de cette demande reste à confirmer.');
  await expect(panel(page)).toContainText('Consultation disponible.');
  await expect(page.getByRole('textbox', { name: 'Question de consultation' })).toHaveValue('');
  const operation = operationFixture(String(request.operationId));
  await queue(page, [{ json: { ok: true, operation } }]);
  await page.getByRole('button', { name: 'Actualiser l’état' }).click();
  await expect(panel(page)).toContainText('Une réponse utile.');
  expect(await calls(page, 'consult')).toHaveLength(0);
  expect((await calls(page, 'status'))[0].body.operationId).toBe(request.operationId);
});

test('cancellation keeps its operation identity and ignores a late completed response', async ({ page }) => {
  await openAnalysis(page); await expect(panel(page)).toContainText('Consultation disponible.');
  const request = await running(page, 'Annuler cette demande en cours.');
  await queue(page, [{ json: { ok: true, operation: operationFixture(request.operationId, 'cancelled') } }]);
  await page.getByRole('button', { name: 'Arrêter la consultation' }).click();
  await expect(panel(page)).toContainText('Consultation annulée.');
  expect((await calls(page, 'cancel'))[0].body.operationId).toBe(request.operationId);
  expect((await calls(page, 'consult'))[0].aborted).toBe(true);
  await respond(page, request, 'Ancienne réponse à ignorer.');
  await expect(panel(page)).not.toContainText('Ancienne réponse à ignorer.');
  await expect(panel(page)).toContainText('Consultation annulée.');
  expect(await calls(page, 'consult')).toHaveLength(1);
});

test('account change discards a late answer and does not recover the previous account operation', async ({ page }) => {
  await openAnalysis(page, 'founder'); await expect(panel(page)).toContainText('Consultation disponible.');
  const request = await running(page, 'Donnée privée du premier compte.');
  await identity(page, 'member', OTHER_OWNER);
  await expect(panel(page)).toHaveCount(0);
  expect((await calls(page, 'consult'))[0].aborted).toBe(true);
  await respond(page, request, 'Réponse réservée au premier compte.');
  await catalogue(page);
  await page.getByRole('button', { name: 'Analyse approfondie', exact: true }).click();
  await expect(panel(page)).toContainText('Consultation disponible.');
  await expect(panel(page)).not.toContainText('Réponse réservée au premier compte.');
  await expect(page.getByRole('textbox', { name: 'Question de consultation' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Actualiser l’état' })).toHaveCount(0);
  expect(await calls(page, 'status')).toHaveLength(0);
  expect(await page.evaluate(owner => sessionStorage.getItem(`purama.consultation.pending.${owner}`), OTHER_OWNER)).toBeNull();
});

test('a large partial answer remains literal, readable and bounded on a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openAnalysis(page); await expect(panel(page)).toContainText('Consultation disponible.');
  const request = await running(page, 'Afficher un grand livrable de transport.');
  const answer = ('<img src=x onerror=alert(1)>\n' + 'résultat '.repeat(4000)).slice(0,32000);
  await respond(page, request, answer, true);
  await expect(panel(page)).toContainText('Réponse partielle reçue.');
  await expect(panel(page).getByRole('article', { name: 'Résultat de consultation' })).toContainText(answer);
  await expect(panel(page).locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await panel(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('consultation-mobile-large.png') });
  expect(await calls(page, 'consult')).toHaveLength(1);
});
