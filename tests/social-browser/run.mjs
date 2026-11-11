// Run directly with Node; no real account, publication, or network provider.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react-swc';
const playwright = await import(process.env.SOCIAL_PLAYWRIGHT_MODULE || 'playwright');
const browserName = process.env.SOCIAL_BROWSER || 'chromium';
if (!['chromium', 'firefox'].includes(browserName)) throw new Error('Unsupported local test browser: ' + browserName);

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testRoot, '../..');
const server = await createServer({
  root: testRoot, configFile: false, plugins: [react()], logLevel: 'error',
  resolve: { alias: [
    { find: '@/integrations/supabase/client', replacement: path.join(testRoot, 'supabase-fixture.js') },
    { find: '@', replacement: path.join(projectRoot, 'src') },
  ] },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [projectRoot] } },
});
let browser;
let passed = 0;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log('Starting local browser at ' + origin);
  async function scenario(label, run, options = {}) {
    console.log('Checking ' + label);
    // A fresh browser prevents accumulation across scenarios in constrained CI.
    // Chromium's sandbox stays enabled; no host protection is changed.
    browser = await playwright[browserName].launch({
      headless: true, timeout: 30000,
      ...(browserName === 'chromium' ? { chromiumSandbox: true } : {}),
      executablePath: process.env.SOCIAL_BROWSER_EXECUTABLE || undefined,
    });
    console.log('Browser launched: ' + browserName + ' ' + browser.version());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    console.log('Context ready');
    context.setDefaultTimeout(15000);
    const errors = [];
    const externalRequests = [];
    const failedLocalRequests = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/')) return route.continue();
      externalRequests.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    console.log('Page ready');
    page.on('pageerror', error => errors.push(String(error)));
    page.on('requestfailed', request => {
      if (request.url().startsWith(origin + '/')) failedLocalRequests.push(request.url());
    });
    await page.addInitScript(value => { window.__socialFixtureOptions = value; }, options);
    try {
      await page.goto(origin + (options.view ? '/?view=' + options.view : '/'));
      await page.locator(options.view === 'settings' ? '[data-testid="settings-control"]'
        : options.view === 'agent' ? '[data-testid="agent-control"] form'
          : '[data-testid="publish-control"] button').waitFor();
      await run(page);
      assert.deepEqual(errors, []);
      assert.deepEqual(externalRequests, [], 'No external request may be attempted');
      assert.deepEqual(failedLocalRequests, [], 'Local fixture resources must load successfully');
      console.log('PASS ' + label); passed++;
    } finally {
      await context.close();
      await browser.close();
      browser = undefined;
    }
  }
  const button = page => page.locator('[data-testid="publish-control"] button');
  async function enqueue(page, ...statuses) {
    await page.evaluate(values => window.__socialFixture.responses.push(...values), statuses);
  }
  async function waitLabel(page, pattern) {
    await page.waitForFunction(source => {
      const node = document.querySelector('[data-testid="publish-control"] button');
      return node && new RegExp(source, 'i').test(node.textContent);
    }, pattern);
  }
  const calls = page => page.evaluate(() => window.__socialFixture.calls.filter(call => call.name === 'social-publish' && call.method === 'POST'));
  const configWrites = page => page.evaluate(() => window.__socialFixture.calls.filter(call => call.name === 'social-autopilot-config' && call.method === 'POST'));
  const waitPending = (page, key) => page.waitForFunction(value => typeof window.__socialFixture.pending[value] === 'function', key);
  const releasePending = async (page, key) => {
    await page.evaluate(value => window.__socialFixture.pending[value](), key);
    await page.waitForFunction(value => window.__socialFixture.completed.includes(value), key);
    // Let the real promise chain and React commit finish; no arbitrary sleep.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await scenario('confirmed publication is the only full success', async page => {
    await enqueue(page, 'published'); await button(page).click();
    await waitLabel(page, 'publi');
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    assert.equal((await calls(page)).length, 1);
    if (process.env.SOCIAL_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.SOCIAL_SCREENSHOT_PATH, fullPage: true });
    }
  });
  await scenario('partial publication is shown separately', async page => {
    await enqueue(page, 'partial'); await button(page).click();
    await waitLabel(page, 'partiel');
    assert.equal((await calls(page)).length, 1);
    assert.equal(await page.getByText('Publié partout !', { exact: true }).count(), 0);
  });
  await scenario('scheduled publication is not presented as already published', async page => {
    await enqueue(page, 'scheduled'); await button(page).click();
    await waitLabel(page, 'programm');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0);
  });
  await scenario('lost response reuses the request key', async page => {
    await enqueue(page, 'network_lost', 'published'); await button(page).click();
    await waitLabel(page, 'vérifier|confirmer'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    const requests = await calls(page); assert.equal(requests.length, 2);
    assert.ok(requests[0].body.clientRequestId);
    assert.equal(requests[0].body.clientRequestId, requests[1].body.clientRequestId);
  });
  await scenario('uncertain result survives remount without a new request identity', async page => {
    await enqueue(page, 'publish_unconfirmed'); await button(page).click();
    await waitLabel(page, 'vérifier|confirmer'); const first = (await calls(page))[0].body.clientRequestId;
    await page.getByRole('button', { name: 'Remonter le bouton' }).click();
    await enqueue(page, 'published'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    assert.equal((await calls(page))[1].body.clientRequestId, first);
  });
  await scenario('uncertain result survives a page reload', async page => {
    await enqueue(page, 'publish_unconfirmed'); await button(page).click();
    await waitLabel(page, 'vérifier|confirmer'); const first = (await calls(page))[0].body.clientRequestId;
    await page.reload(); await button(page).waitFor();
    await enqueue(page, 'published'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    assert.equal((await calls(page))[0].body.clientRequestId, first);
  });
  await scenario('changing content starts a distinct publication intent', async page => {
    await enqueue(page, 'publish_unconfirmed'); await button(page).click();
    await waitLabel(page, 'vérifier|confirmer'); const first = (await calls(page))[0].body.clientRequestId;
    await page.getByLabel('Contenu de test').fill('Une autre publication PURAMA choisie explicitement.');
    await enqueue(page, 'published'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    assert.notEqual((await calls(page))[1].body.clientRequestId, first);
  });
  await scenario('a late result cannot announce success for content that has changed', async page => {
    await enqueue(page, { status: 'published', defer: 'old-content' });
    await button(page).click();
    await waitPending(page, 'old-content');
    await page.getByLabel('Contenu de test').fill('Un nouveau contenu encore non publié.');
    await releasePending(page, 'old-content');
    await waitLabel(page, 'publier sur mes réseaux');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0,
      'The old result must not call the active content completion callback');
    assert.equal(await page.getByText('Publication confirmée', { exact: true }).count(), 0);
  });
  await scenario('a late publication cannot announce success in another user session', async page => {
    await enqueue(page, { status: 'published', defer: 'old-owner' });
    await button(page).click(); await waitPending(page, 'old-owner');
    await page.getByRole('button', { name: 'Utiliser le compte B' }).click();
    await releasePending(page, 'old-owner');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0);
    assert.equal(await page.getByText('Publication confirmée', { exact: true }).count(), 0);
    await enqueue(page, 'published'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    const requests = await calls(page);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].headers.authorization, 'Bearer fixture-token');
    assert.equal(requests[1].headers.authorization, 'Bearer fixture-other-token');
    assert.notEqual(requests[0].body.clientRequestId, requests[1].body.clientRequestId);
    assert.equal(await page.evaluate(() => window.__socialFixture.published[0].owner), 'fixture-other');
  });
  await scenario('a result from an unmounted button is inert after remount', async page => {
    await enqueue(page, { status: 'published', defer: 'old-mount' });
    await button(page).click(); await waitPending(page, 'old-mount');
    await page.getByRole('button', { name: 'Remonter le bouton' }).click();
    await releasePending(page, 'old-mount');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0);
    assert.equal(await page.getByText('Publication confirmée', { exact: true }).count(), 0);
    assert.equal((await calls(page)).length, 1);
    assert.equal(await button(page).isEnabled(), true);
  });
  await scenario('signing out suppresses an old publication result and disables new sends', async page => {
    await enqueue(page, { status: 'published', defer: 'signed-out-result' });
    await button(page).click(); await waitPending(page, 'signed-out-result');
    await page.getByRole('button', { name: 'Déconnecter la session' }).click();
    await releasePending(page, 'signed-out-result');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0);
    assert.equal(await page.getByText('Publication confirmée', { exact: true }).count(), 0);
    assert.equal(await button(page).isDisabled(), true);
    assert.equal((await calls(page)).length, 1);
  });
  await scenario('deadline releases a stalled button and a retry keeps the same intent', async page => {
    await page.clock.install();
    await enqueue(page, { status: 'published', defer: 'timed-out-result' });
    await button(page).click(); await waitPending(page, 'timed-out-result');
    await page.clock.fastForward(31_000);
    await waitLabel(page, 'vérifier|confirmer');
    assert.equal(await button(page).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0);
    await enqueue(page, 'published'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    const requests = await calls(page);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.clientRequestId, requests[1].body.clientRequestId);
    await releasePending(page, 'timed-out-result');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 1);
    assert.equal((await calls(page)).length, 2);
  });
  await scenario('autopilot cannot use an old user configuration to publish as a new user', async page => {
    await page.evaluate(() => {
      window.__socialFixture.plans.push({ name: 'social-autopilot-config', method: 'GET',
        owner: 'fixture-owner', defer: 'old-autopilot-config',
        data: { user_id: 'fixture-owner', autopilot_enabled: true, default_platforms: ['instagram'],
          auto_caption: false, auto_hashtags: false, timezone: 'Europe/Paris' } });
      window.__autopilotResult = undefined;
      void window.__socialClient.maybeAutopilot({ content: 'Contenu privé A destiné au compte A.' })
        .then(value => { window.__autopilotResult = value; });
    });
    await waitPending(page, 'old-autopilot-config');
    await page.getByRole('button', { name: 'Utiliser le compte B' }).click();
    await releasePending(page, 'old-autopilot-config');
    await page.waitForFunction(() => window.__autopilotResult !== undefined);
    assert.equal(await page.evaluate(() => window.__autopilotResult), false);
    assert.equal((await calls(page)).length, 0);
  });
  await scenario('late account loading cannot expose a previous user account or history', async page => {
    await waitPending(page, 'old-account-list');
    await page.getByRole('button', { name: 'Utiliser le compte B' }).click();
    await page.getByText('Compte social privé B', { exact: true }).waitFor();
    await releasePending(page, 'old-account-list');
    assert.equal(await page.getByText('Compte social privé A', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Publication privée A', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Publication privée B', { exact: true }).count(), 1);
  }, { view: 'settings', plans: [{ name: 'social-accounts', method: 'GET',
    owner: 'fixture-owner', defer: 'old-account-list' }] });
  await scenario('an old configuration save cannot change the new user settings', async page => {
    await page.getByText('Compte social privé A', { exact: true }).waitFor();
    await page.evaluate(() => window.__socialFixture.plans.push({ name: 'social-autopilot-config',
      method: 'POST', owner: 'fixture-owner', defer: 'old-config-save' }));
    await page.getByRole('switch').click(); await waitPending(page, 'old-config-save');
    await page.getByRole('button', { name: 'Utiliser le compte B' }).click();
    await page.getByText('Compte social privé B', { exact: true }).waitFor();
    await releasePending(page, 'old-config-save');
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'false');
    const writes = await configWrites(page);
    assert.equal(writes.length, 1); assert.equal(writes[0].owner, 'fixture-owner');
    assert.equal(writes[0].headers.authorization, 'Bearer fixture-token');
    assert.equal(await page.getByText('Échec sauvegarde', { exact: true }).count(), 0);
  }, { view: 'settings' });
  await scenario('rapid configuration clicks start one save and recover after confirmation', async page => {
    await page.getByText('Compte social privé A', { exact: true }).waitFor();
    await page.evaluate(() => window.__socialFixture.plans.push({ name: 'social-autopilot-config',
      method: 'POST', owner: 'fixture-owner', defer: 'single-save' }));
    await page.getByRole('switch').evaluate(node => { node.click(); node.click(); });
    await waitPending(page, 'single-save');
    assert.equal((await configWrites(page)).length, 1);
    assert.equal(await page.getByRole('switch').isDisabled(), true);
    await releasePending(page, 'single-save');
    assert.equal(await page.getByRole('switch').isEnabled(), true);
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
  }, { view: 'settings' });
  await scenario('signing out removes private settings and history', async page => {
    await page.getByText('Compte social privé A', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Déconnecter la session' }).click();
    await page.getByText('Compte social privé A', { exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByText('Publication privée A', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('switch').count(), 0);
  }, { view: 'settings' });
  await scenario('failed saving and rereading leave an explicit error until a successful refresh', async page => {
    await page.getByText('Compte social privé A', { exact: true }).waitFor();
    await page.evaluate(() => window.__socialFixture.plans.push(
      { name: 'social-autopilot-config', method: 'POST', owner: 'fixture-owner', error: 'Réponse de sauvegarde perdue' },
      { name: 'social-autopilot-config', method: 'GET', owner: 'fixture-owner', error: 'Relecture indisponible' },
    ));
    await page.getByRole('switch').click();
    const error = page.locator('[data-testid="settings-control"]').getByRole('alert');
    await error.waitFor();
    assert.match(await error.innerText(), /n’a pas pu être confirmé/);
    assert.equal(await page.getByRole('switch').count(), 0);
    const refresh = page.getByRole('button', { name: 'Actualiser', exact: true });
    assert.equal(await refresh.isEnabled(), true);
    await refresh.click();
    await page.getByRole('switch').waitFor();
    assert.equal(await error.count(), 0);
    assert.equal(await page.getByRole('switch').getAttribute('aria-checked'), 'true');
    assert.equal((await configWrites(page)).length, 1);
  }, { view: 'settings' });
  await scenario('a generated result and its publish control disappear when the user changes', async page => {
    await page.getByLabel('Votre message').fill('Préparer un contenu privé pour A.');
    await page.getByRole('button', { name: /Lancer l.agent/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Résultat privé généré pour le compte A.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Publier sur mes réseaux', exact: true }).waitFor();
    // A real auth event may occur while the modal traps focus. Dispatch the
    // harness account control without dismissing the modal first.
    await page.getByRole('button', { name: 'Utiliser le compte B', includeHidden: true })
      .evaluate(node => node.click());
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.getByText('Résultat privé généré pour le compte A.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Publier sur mes réseaux', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Votre message').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: /Lancer l.agent/ }).isEnabled(), true);
    assert.equal((await calls(page)).length, 0);
  }, { view: 'agent' });
  await scenario('late generation cannot open a result or start autopilot in a new session', async page => {
    await page.getByLabel('Votre message').fill('Préparer un autre contenu privé pour A.');
    await page.getByRole('button', { name: /Lancer l.agent/ }).click();
    await waitPending(page, 'old-generation');
    await page.getByRole('button', { name: 'Utiliser le compte B' }).click();
    await releasePending(page, 'old-generation');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByText('Résultat privé généré pour le compte A.', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Agent exécuté avec succès !', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Publier sur mes réseaux', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /Lancer l.agent/ }).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__socialFixture.calls
      .filter(call => call.name === 'social-autopilot-config').length), 0);
    assert.equal((await calls(page)).length, 0);
    const executions = await page.evaluate(() => window.__socialFixture.calls.filter(call => call.name === 'agent-proxy'));
    assert.equal(executions.length, 1);
    assert.equal(executions[0].owner, 'fixture-owner');
  }, { view: 'agent', plans: [{ name: 'agent-proxy', method: 'POST', owner: 'fixture-owner', defer: 'old-generation' }] });

  const enabledAutopilot = { user_id: 'fixture-owner', autopilot_enabled: true,
    default_platforms: ['instagram'], auto_caption: false, auto_hashtags: false, timezone: 'Europe/Paris' };
  const deferredAutopilot = key => ({ view: 'agent', plans: [
    { name: 'social-autopilot-config', method: 'GET', owner: 'fixture-owner', defer: key, data: enabledAutopilot },
  ] });
  async function generateUntilAutopilotWaits(page, key) {
    await page.getByLabel('Votre message').fill('Contenu privé généré avec autopilote actif.');
    await page.getByRole('button', { name: /Lancer l.agent/ }).click();
    await waitPending(page, key);
  }
  async function changeSession(page, label, owner) {
    await page.getByRole('button', { name: label, exact: true, includeHidden: true }).evaluate(node => node.click());
    await page.waitForFunction(value => document.querySelector('[data-testid="active-owner"]')?.textContent === value, owner);
  }
  await scenario('a current agent lifetime completes its deferred authorized autopilot', async page => {
    await generateUntilAutopilotWaits(page, 'current-autopilot');
    await releasePending(page, 'current-autopilot');
    await page.waitForFunction(() => window.__socialFixture.calls.some(call => call.name === 'social-publish' && call.method === 'POST'));
    assert.equal((await calls(page)).length, 1);
    assert.equal((await calls(page))[0].owner, 'fixture-owner');
    assert.equal((await calls(page))[0].body.forceCaption, false);
  }, deferredAutopilot('current-autopilot'));
  await scenario('deferred agent autopilot is inert after switching to another account', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-other-owner');
    await changeSession(page, 'Utiliser le compte B', 'fixture-other');
    await releasePending(page, 'autopilot-other-owner');
    assert.equal((await calls(page)).length, 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
  }, deferredAutopilot('autopilot-other-owner'));
  await scenario('deferred agent autopilot cannot revive after A to B to A', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-aba');
    await changeSession(page, 'Utiliser le compte B', 'fixture-other');
    await changeSession(page, 'Utiliser le compte A', 'fixture-owner');
    await releasePending(page, 'autopilot-aba');
    assert.equal((await calls(page)).length, 0, 'An old agent lifetime must not publish when its owner returns');
    assert.equal(await page.getByRole('dialog').count(), 0);
  }, deferredAutopilot('autopilot-aba'));
  await scenario('deferred agent autopilot is inert after signing out', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-signed-out');
    await changeSession(page, 'Déconnecter la session', 'signed-out');
    await releasePending(page, 'autopilot-signed-out');
    assert.equal((await calls(page)).length, 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
  }, deferredAutopilot('autopilot-signed-out'));
  await scenario('deferred agent autopilot cannot revive after signing out and back in', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-login-return');
    await changeSession(page, 'Déconnecter la session', 'signed-out');
    await changeSession(page, 'Utiliser le compte A', 'fixture-owner');
    await releasePending(page, 'autopilot-login-return');
    assert.equal((await calls(page)).length, 0);
  }, deferredAutopilot('autopilot-login-return'));
  await scenario('deferred agent autopilot is inert after the agent view unmounts', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-unmounted');
    await page.getByRole('button', { name: 'Masquer la vue', includeHidden: true }).evaluate(node => node.click());
    await page.locator('[data-testid="agent-control"]').waitFor({ state: 'detached' });
    await releasePending(page, 'autopilot-unmounted');
    assert.equal((await calls(page)).length, 0);
  }, deferredAutopilot('autopilot-unmounted'));
  await scenario('deferred autopilot is inert after selecting a different agent', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-agent-changed');
    await page.getByRole('button', { name: 'Changer l’agent', includeHidden: true }).evaluate(node => node.click());
    await page.waitForFunction(() => document.querySelector('[data-testid="active-agent"]')?.textContent === 'hashtags-viraux');
    await releasePending(page, 'autopilot-agent-changed');
    assert.equal((await calls(page)).length, 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
  }, deferredAutopilot('autopilot-agent-changed'));
  await scenario('pending autopilot does not block another agent execution', async page => {
    await generateUntilAutopilotWaits(page, 'autopilot-next-execution');
    await page.getByRole('button', { name: 'Nouvelle exécution', exact: true }).click();
    await page.getByLabel('Votre message').fill('Une deuxième génération choisie explicitement.');
    await page.getByRole('button', { name: /Lancer l.agent/ }).click();
    await page.getByRole('dialog').waitFor();
    const executions = await page.evaluate(() => window.__socialFixture.calls.filter(call => call.name === 'agent-proxy'));
    assert.equal(executions.length, 2, 'The generation channel must be released while autopilot waits');
    await releasePending(page, 'autopilot-next-execution');
    await page.waitForFunction(() => window.__socialFixture.calls.some(call => call.name === 'social-publish' && call.method === 'POST'));
    assert.equal((await calls(page)).length, 1);
  }, deferredAutopilot('autopilot-next-execution'));
  await scenario('a late manual publication stays inert across A to B to A and retry keeps its intent', async page => {
    await enqueue(page, { status: 'published', defer: 'manual-publication-aba' });
    await button(page).click(); await waitPending(page, 'manual-publication-aba');
    await changeSession(page, 'Utiliser le compte B', 'fixture-other');
    await changeSession(page, 'Utiliser le compte A', 'fixture-owner');
    await releasePending(page, 'manual-publication-aba');
    assert.equal(await page.evaluate(() => window.__socialFixture.published.length), 0);
    assert.equal(await page.getByText('Publication confirmée', { exact: true }).count(), 0);
    await enqueue(page, 'published'); await button(page).click();
    await page.waitForFunction(() => window.__socialFixture.published.length === 1);
    const requests = await calls(page);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.clientRequestId, requests[1].body.clientRequestId);
    assert.equal(requests[0].owner, 'fixture-owner'); assert.equal(requests[1].owner, 'fixture-owner');
  });
  console.log(`RESULT ${passed} browser scenarios passed; zero page errors, failed local resources, or external requests.`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
