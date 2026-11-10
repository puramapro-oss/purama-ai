import { test, expect } from '@playwright/test';
import { createBrowserHarness } from './browser-harness.mjs';

// Exécuter avec browser.config.mjs : pas de Supabase distant, pas de remplacement des RPC.
test.describe.configure({ mode: 'serial' });
let harness;
let contexts = [];
let historyStart = 0;
let serverErrorsStart = 0;

test.beforeAll(async ({}, testInfo) => {
  // La configuration Playwright générale du dépôt ne doit pas allouer cette DB par projet.
  test.skip(testInfo.project.name !== 'entraide-local', 'Utiliser tests/entraide/browser.config.mjs');
  testInfo.setTimeout(150_000);
  harness = await createBrowserHarness();
});

test.beforeEach(() => {
  contexts = [];
  historyStart = harness.history.length;
  serverErrorsStart = harness.serverErrors.length;
});

test.afterEach(async ({}, testInfo) => {
  if (!harness) return;
  const transcript = harness.history.slice(historyStart);
  await testInfo.attach('api-transcript-without-tokens', {
    body: Buffer.from(JSON.stringify(transcript, null, 2)), contentType: 'application/json',
  });
  await testInfo.attach('postgresql-state', {
    body: Buffer.from(JSON.stringify(await harness.snapshot(), null, 2)), contentType: 'application/json',
  });
  await testInfo.attach('verification-scope', {
    body: Buffer.from(JSON.stringify({
      database: harness.engine,
      real: ['Entraide.tsx', 'React Query', 'requestEntraide', 'createEntraideHandler', 'SQL migrations', 'mission/contact RPC', 'computeMatchScore'],
      fixtures: ['Alice/Bob authentication', 'SQL profile ports instead of Supabase PostgREST', 'Google Fonts omitted'],
      notVerified: ['Hosted Supabase authentication', 'deployed Edge runtime', 'production database'],
    }, null, 2)), contentType: 'application/json',
  });
  for (const [index, item] of contexts.entries()) {
    await testInfo.attach(`browser-errors-${item.alias}-${index}`, {
      body: Buffer.from(JSON.stringify(item.errors, null, 2)), contentType: 'application/json',
    });
    if (testInfo.status !== testInfo.expectedStatus && !item.page.isClosed()) {
      await testInfo.attach(`failure-${item.alias}-${index}`, {
        body: await item.page.screenshot({ fullPage: true }), contentType: 'image/png',
      });
    }
    const trace = testInfo.outputPath(`trace-${item.alias}-${index}.zip`);
    await item.context.tracing.stop({ path: trace });
    await testInfo.attach(`trace-${item.alias}-${index}`, { path: trace, contentType: 'application/zip' });
    await item.context.close();
  }
});

test.afterAll(async () => { await harness?.close(); });

async function actorPage(browser, alias, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'fr-FR', reducedMotion: 'reduce' });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push({ kind: 'pageerror', text: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push({ kind: 'console', text: message.text(), url: message.location().url });
  });
  page.on('requestfailed', (request) => {
    const text = request.failure()?.errorText ?? 'unknown';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(text)) errors.push({ kind: 'requestfailed', text, url: request.url() });
  });
  contexts.push({ context, page, alias, errors });
  await page.goto(`${harness.baseURL}/?actor=${alias}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Réseau d’entraide' })).toBeVisible();
  await expect(page.getByLabel('Ce que tu peux partager', { exact: true })).toBeVisible();
  return page;
}

function isApiResponse(response, route, method) {
  return new URL(response.url()).pathname === `/functions/v1/${route}` && response.request().method() === method;
}

async function invokeByClick(page, route, method, button) {
  const pending = page.waitForResponse((response) => isApiResponse(response, route, method));
  await button.click();
  const response = await pending;
  expect(response.status(), `${method} ${route}`).toBe(200);
  return { body: await response.json(), request: response.request().postDataJSON() };
}

async function refresh(page, scope) {
  await page.evaluate((value) => window.__ENTRAIDE_FIXTURE_CONTROLS__.refresh(value), scope);
}

async function fillProfile(page, offered, needed) {
  await page.getByLabel('Ce que tu peux partager', { exact: true }).fill(offered);
  await page.getByLabel('Ce que tu recherches', { exact: true }).fill(needed);
  await page.getByLabel('Lundi', { exact: true }).check();
  await page.getByLabel('Rayon souhaité en kilomètres · facultatif', { exact: true }).fill('10');
  await invokeByClick(page, 'entraide-profil', 'PUT', page.getByRole('button', { name: 'Enregistrer mon profil', exact: true }));
  await expect(page.getByText('Ton profil est enregistré.', { exact: true })).toBeVisible();
}

function missionCard(page, title) {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function assertNoUnexpectedFailures() {
  const transcript = harness.history.slice(historyStart);
  expect(harness.serverErrors.slice(serverErrorsStart), 'exceptions dans le serveur de fixture').toEqual([]);
  expect(transcript.filter((entry) => entry.deliveredStatus >= 400 && !entry.injectedFault), 'réponses HTTP inattendues').toEqual([]);
  const expectedFailureURLs = new Set(transcript.filter((entry) => entry.injectedFault)
    .map((entry) => `${harness.baseURL}/functions/v1/${entry.route}`));
  const failures = contexts.flatMap((item) => item.errors.filter((error) => !(
    error.kind === 'console' && /503/.test(error.text) && expectedFailureURLs.has(error.url)
  )));
  expect(failures, 'erreurs navigateur inattendues').toEqual([]);
}

test('profil enregistré, mission privée publiée, Bob rejoint et Alice déclare la fin', async ({ browser }, testInfo) => {
  const alice = await actorPage(browser, 'alice');
  await fillProfile(alice, 'couture', 'jardinage');
  const bob = await actorPage(browser, 'bob');
  await fillProfile(bob, 'jardinage', 'couture');
  const initial = await harness.snapshot();
  expect(initial.profiles.find((row) => row.user_id === harness.actors.alice)).toMatchObject({
    skills_offered: ['couture'], skills_needed: ['jardinage'], availability_days: ['mon'], radius_km: 10,
  });
  expect(initial.profiles.find((row) => row.user_id === harness.actors.bob).skills_offered).toEqual(['jardinage']);

  const title = 'Jardin de quartier — parcours vérifié';
  await alice.getByRole('tab', { name: 'Missions', exact: true }).click();
  await expect(alice.getByRole('radio', { name: /^Privée/ })).toBeChecked();
  await alice.getByLabel('Titre de la mission', { exact: true }).fill(title);
  await alice.getByLabel('Objectif et coup de main attendu', { exact: true }).fill('Préparer ensemble deux bacs de culture et partager les savoir-faire.');
  await alice.getByLabel('Participants maximum', { exact: true }).fill('2');
  const created = await invokeByClick(alice, 'entraide-missions', 'POST', alice.getByRole('button', { name: 'Créer ma mission privée', exact: true }));
  const missionId = created.body.mission.id;
  expect(created.request.id).toBe(missionId);
  expect(created.body.mission).toMatchObject({ organizer_id: harness.actors.alice, visibility: 'private', status: 'ouverte', revision: 0 });
  const privateState = await harness.snapshot();
  expect(privateState.participants.filter((row) => row.mission_id === missionId)).toEqual([{ mission_id: missionId, user_id: harness.actors.alice }]);

  const bobList = bob.waitForResponse((response) => isApiResponse(response, 'entraide-missions', 'GET'));
  await bob.getByRole('tab', { name: 'Missions', exact: true }).click();
  expect((await (await bobList).json()).missions.some((mission) => mission.id === missionId)).toBe(false);
  await expect(missionCard(bob, title)).toHaveCount(0);

  const published = await invokeByClick(alice, `entraide-missions/${missionId}/publish`, 'POST', missionCard(alice, title).getByRole('button', { name: 'Rendre visible au réseau', exact: true }));
  expect(published.request.expected_revision).toBe(0);
  expect(published.body.mission.visibility).toBe('public');
  await refresh(bob, 'missions');
  await expect(missionCard(bob, title)).toBeVisible();
  await expect(missionCard(bob, title).getByRole('button', { name: 'Démarrer la mission', exact: true })).toHaveCount(0);
  const joined = await invokeByClick(bob, `entraide-missions/${missionId}/join`, 'POST', missionCard(bob, title).getByRole('button', { name: 'Rejoindre la mission', exact: true }));
  expect(joined.body.mission.status).toBe('prete');
  expect(joined.body.mission.missions_collectives_participants.map((item) => item.user_id).sort()).toEqual(Object.values(harness.actors).sort());

  await refresh(alice, 'missions');
  const started = await invokeByClick(alice, `entraide-missions/${missionId}/start`, 'POST', missionCard(alice, title).getByRole('button', { name: 'Démarrer la mission', exact: true }));
  expect(started.request.expected_revision).toBe(joined.body.mission.revision);
  expect(started.body.mission.status).toBe('en_cours');
  const completed = await invokeByClick(alice, `entraide-missions/${missionId}/complete`, 'POST', missionCard(alice, title).getByRole('button', { name: 'Déclarer la mission terminée', exact: true }));
  expect(completed.request.expected_revision).toBe(started.body.mission.revision);
  expect(completed.body.mission.status).toBe('terminee');
  await expect(missionCard(alice, title).getByText('Déclarée terminée', { exact: true })).toBeVisible();
  await expect(missionCard(alice, title).getByText(/ni une preuve indépendante du résultat ni une autorisation de paiement/)).toBeVisible();
  const final = await harness.snapshot();
  expect(final.missions.find((row) => row.id === missionId)).toMatchObject({ status: 'terminee', visibility: 'public', revision: completed.body.mission.revision });
  expect(final.participants.filter((row) => row.mission_id === missionId)).toHaveLength(2);
  await testInfo.attach('mission-declared-complete', { body: await alice.screenshot({ fullPage: true }), contentType: 'image/png' });
  await assertNoUnexpectedFailures();
});

test('contact accepté puis bloqué et débloqué sans réactiver l’acceptation', async ({ browser }, testInfo) => {
  const alice = await actorPage(browser, 'alice');
  await expect(alice.getByRole('button', { name: 'Demander un contact', exact: true })).toBeEnabled();
  await alice.getByLabel('Message joint à ta demande · facultatif', { exact: true }).fill('Bonjour Bob, partageons nos savoir-faire autour du jardin.');
  const sent = await invokeByClick(alice, 'entraide-contact', 'POST', alice.getByRole('button', { name: 'Demander un contact', exact: true }));
  const requestId = sent.body.request.id;
  expect(sent.request.id).toBe(requestId);
  expect(sent.body.request).toMatchObject({ requester_id: harness.actors.alice, recipient_id: harness.actors.bob, status: 'pending' });

  // Ouvrir Bob après l'envoi déclenche de vraies lectures initiales, sans données injectées dans React.
  const bob = await actorPage(browser, 'bob');
  await bob.getByRole('tab', { name: 'Contacts', exact: true }).click();
  const accepted = await invokeByClick(bob, `entraide-contact/${requestId}/respond`, 'POST', bob.getByRole('button', { name: 'Accepter', exact: true }));
  expect(accepted.body.request.status).toBe('accepted');
  await expect(bob.getByText('Acceptée', { exact: true })).toBeVisible();
  expect((await harness.snapshot()).contacts.find((row) => row.id === requestId).status).toBe('accepted');

  await invokeByClick(bob, 'entraide-contact/block', 'POST', bob.getByRole('button', { name: 'Bloquer ce membre', exact: true }));
  await expect(bob.getByRole('heading', { name: 'Mes blocages', exact: true })).toBeVisible();
  const blocked = await harness.snapshot();
  expect(blocked.contacts.find((row) => row.id === requestId).status).toBe('blocked');
  expect(blocked.blocks).toEqual([{ blocker_id: harness.actors.bob, blocked_id: harness.actors.alice }]);

  await invokeByClick(bob, 'entraide-contact/unblock', 'POST', bob.getByRole('button', { name: 'Débloquer', exact: true }));
  await expect(bob.getByRole('heading', { name: 'Mes blocages', exact: true })).toHaveCount(0);
  await expect(bob.getByText('Contact indisponible', { exact: true })).toBeVisible();
  await expect(bob.getByText('Acceptée', { exact: true })).toHaveCount(0);
  await expect(bob.getByRole('button', { name: 'Accepter', exact: true })).toHaveCount(0);
  await expect(bob.getByText(/cet écran ne comporte pas de messagerie/)).toBeVisible();
  const unblocked = await harness.snapshot();
  expect(unblocked.blocks).toEqual([]);
  expect(unblocked.contacts.find((row) => row.id === requestId).status).toBe('blocked');
  await testInfo.attach('contact-unblocked-without-restoring-consent', { body: await bob.screenshot({ fullPage: true }), contentType: 'image/png' });
  await assertNoUnexpectedFailures();
});

test('brouillon préservé, créations reprises sans doublon et interface à 390 pixels', async ({ browser }, testInfo) => {
  const alice = await actorPage(browser, 'alice', { width: 390, height: 844 });
  await alice.getByLabel('Ce que tu peux partager', { exact: true }).fill('couture, dessin non enregistré');
  const held = harness.holdNextResponse({ actor: 'alice', route: 'entraide-profil', method: 'GET' });
  const reloading = refresh(alice, 'profil');
  try {
    await held.arrived;
    await expect(alice.getByLabel('Ce que tu peux partager', { exact: true })).toHaveValue('couture, dessin non enregistré');
  } finally { held.release(); }
  await reloading;
  await expect(alice.getByLabel('Ce que tu peux partager', { exact: true })).toHaveValue('couture, dessin non enregistré');
  expect((await harness.snapshot()).profiles.find((row) => row.user_id === harness.actors.alice).skills_offered).toEqual(['couture']);

  await alice.getByRole('tab', { name: 'Missions', exact: true }).click();
  await alice.getByRole('tab', { name: 'Profil', exact: true }).click();
  await expect(alice.getByLabel('Ce que tu peux partager', { exact: true })).toHaveValue('couture, dessin non enregistré');
  await alice.getByRole('tab', { name: 'Missions', exact: true }).click();

  const createButton = alice.getByRole('button', { name: 'Créer ma mission privée', exact: true });
  const titleInput = alice.getByLabel('Titre de la mission', { exact: true });
  await titleInput.fill('Une seule création malgré la réponse perdue');
  await alice.getByLabel('Objectif et coup de main attendu', { exact: true }).fill('Cette intention doit conserver son identifiant lors de la reprise.');
  harness.failNextAfterCommit({ actor: 'alice', route: 'entraide-missions' });
  let lost = alice.waitForResponse((response) => isApiResponse(response, 'entraide-missions', 'POST'));
  await createButton.click();
  const firstLoss = await lost;
  expect(firstLoss.status()).toBe(503);
  const originalId = firstLoss.request().postDataJSON().id;
  await expect(alice.getByRole('alert').filter({ hasText: 'momentanément indisponible' })).toBeVisible();
  await expect(titleInput).toHaveValue('Une seule création malgré la réponse perdue');
  expect((await harness.snapshot()).missions.filter((row) => row.id === originalId)).toHaveLength(1);
  const retried = await invokeByClick(alice, 'entraide-missions', 'POST', createButton);
  expect(retried.request.id).toBe(originalId);
  expect(retried.body.mission.id).toBe(originalId);
  expect((await harness.snapshot()).missions.filter((row) => row.id === originalId)).toHaveLength(1);
  await expect(titleInput).toHaveValue('');

  await titleInput.fill('Intention avant modification');
  harness.failNextAfterCommit({ actor: 'alice', route: 'entraide-missions' });
  lost = alice.waitForResponse((response) => isApiResponse(response, 'entraide-missions', 'POST'));
  await createButton.click();
  const secondLoss = await lost;
  expect(secondLoss.status()).toBe(503);
  const previousIntent = secondLoss.request().postDataJSON().id;
  await expect(alice.getByRole('alert').filter({ hasText: 'momentanément indisponible' })).toBeVisible();
  await titleInput.fill('Intention modifiée après la réponse perdue');
  const changed = await invokeByClick(alice, 'entraide-missions', 'POST', createButton);
  expect(changed.request.id).not.toBe(previousIntent);
  const state = await harness.snapshot();
  expect(state.missions.find((row) => row.id === previousIntent).title).toBe('Intention avant modification');
  expect(state.missions.find((row) => row.id === changed.request.id).title).toBe('Intention modifiée après la réponse perdue');

  for (const tab of ['Profil', 'Missions', 'Contacts']) {
    await alice.getByRole('tab', { name: tab, exact: true }).click();
    await expect(alice.getByRole('tabpanel')).toBeVisible();
    const overflow = await alice.evaluate(() => {
      const width = window.innerWidth;
      const outside = [...document.querySelectorAll('main button,main input,main textarea,main [role="tablist"],main h1,main h3,main li')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > width + 1);
        }).map((element) => ({ tag: element.tagName, text: element.textContent?.slice(0, 80) }));
      return { document: document.documentElement.scrollWidth > width + 1, outside };
    });
    expect(overflow, `débordement horizontal dans ${tab} à 390 px`).toEqual({ document: false, outside: [] });
  }
  await testInfo.attach('mobile-390px', { body: await alice.screenshot({ fullPage: true }), contentType: 'image/png' });
  await assertNoUnexpectedFailures();
});
