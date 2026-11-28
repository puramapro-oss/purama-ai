import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.env.OAUTH_SOURCE_ROOT ?? resolve(here, '../../..'));
const evidence = resolve(process.env.OAUTH_BROWSER_EVIDENCE ?? resolve(here, '../evidence/browser'));
const filter = process.env.OAUTH_BROWSER_FILTER ? new RegExp(process.env.OAUTH_BROWSER_FILTER) : null;
const sources = ['src/pages/OAuthCallback.tsx', 'src/hooks/useUserConnections.ts', 'src/hooks/useRequestScope.ts', 'src/lib/request-scope.ts', 'src/lib/request-deadline.ts'];
sources.push('src/lib/email-agent.ts');
try { await access(resolve(source, 'src/lib/oauth-google.ts')); sources.push('src/lib/oauth-google.ts', 'supabase/functions/_shared/request-body.ts'); } catch { /* The baseline has no OAuth helper. */ }
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(resolve(source, path))).digest('hex')])));
const result = { startedAt: new Date().toISOString(), source, sources: await hashes(), checks: [], externalRequests: [] };
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const STATE = 'ab'.repeat(32);
let browser, server, origin;
const checkpoint = async () => { await mkdir(evidence, { recursive: true }); await writeFile(resolve(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n'); };
const pendingAuth = (page, count = 1) => page.waitForFunction(count => window.oauthPort.auth.length >= count, count);
const pendingFetch = (page, count = 1) => page.waitForFunction(count => window.oauthPort.fetches.length >= count, count);
const tick = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
async function check(name, mode, fn, options = {}) {
  if (filter && !filter.test(name)) return;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const errors = []; const outside = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && ['GET', 'HEAD'].includes(route.request().method())) return route.continue();
    outside.push(url.origin); return route.abort();
  });
  await context.routeWebSocket('**/*', route => { outside.push(route.url()); route.close(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(4000);
  await page.addInitScript(({ state, owner }) => {
    sessionStorage.setItem('oauth_state', state);
    const purpose = new URLSearchParams(location.search).get('mode') === 'gmail' ? 'email_agent_gmail' : 'google_connections';
    sessionStorage.setItem('oauth_context', JSON.stringify({ state, userId: owner, provider: 'gmail', purpose, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    window.__unhandled = [];
    window.addEventListener('unhandledrejection', event => { window.__unhandled.push(String(event.reason)); event.preventDefault(); });
  }, { state: STATE, owner: OWNER });
  try {
    // Install before app code creates a deadline; replacing the clock after
    // mount leaves existing native timers outside Playwright's virtual clock.
    if (options.clock) await page.clock.install();
    await page.goto(`${origin}/?mode=${mode}`);
    await expect(page.getByTestId('account')).toHaveText(OWNER);
    await fn(page);
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    assert.deepEqual(await page.evaluate(() => window.__unhandled), []);
    result.checks.push({ name, status: 'PASS' }); console.log('PASS ' + name);
  } catch (error) {
    result.checks.push({ name, status: 'FAIL', message: error.message, errors, outside }); console.error('FAIL ' + name + ': ' + error.message);
  } finally { await context.close(); await checkpoint(); }
}
try {
  const bundle = await build({ entryPoints: [resolve(here, 'entry.tsx')], bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [resolve(source, 'node_modules')],
    alias: { '@/integrations/supabase/client': resolve(here, 'transport.ts'), '@': resolve(source, 'src') },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.VITE_SUPABASE_URL': '"https://database.fixture.invalid"',
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': '"fixture-public-key"' },
  });
  const bytes = bundle.outputFiles[0].contents;
  result.bundleSha256 = createHash('sha256').update(bytes).digest('hex');
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bytes); }
    else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  result.browser = browser.version();

  await check('leaving a rejected callback cancels its pending redirect', 'error', async page => {
    await expect(page.getByText('Autorisation refusée')).toBeVisible();
    await page.evaluate(() => window.navigateFixture('/kept'));
    await page.waitForTimeout(2300);
    await expect(page.getByTestId('path')).toHaveText('/kept');
  });

  await check('late callback success cannot cross an account change', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER);
    await pendingFetch(page); await page.evaluate(other => window.switchIdentity(other), OTHER);
    await expect(page.getByTestId('account')).toHaveText(OTHER);
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' }));
    await tick(page);
    assert.equal(await page.getByText('Compte connecté avec succès !').count(), 0);
    assert.equal(await page.getByText('Compte connecté avec succès', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  });

  await check('double initiation admits only one session read', 'hook', async page => {
    await page.evaluate(() => { void window.startOAuth(); void window.startOAuth(); });
    await pendingAuth(page); await tick(page);
    assert.equal(await page.evaluate(() => window.oauthPort.auth.length), 1);
  });

  await check('HTTP 200 without an explicit success receipt is rejected', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER);
    await pendingFetch(page); await page.evaluate(() => window.oauthPort.resolveFetch(0, {}));
    await tick(page);
    assert.equal(await page.getByText('Compte connecté avec succès !').count(), 0);
    await expect(page.getByRole('heading', { name: 'Erreur', exact: true })).toBeVisible();
  });

  await check('a session read from another account cannot start authorization', 'hook', async page => {
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(other => window.oauthPort.resolveAuth(0, other), OTHER); await tick(page);
    assert.equal(await page.evaluate(() => window.oauthPort.fetches.length), 0);
  });

  await check('a network rejection during initiation is handled and can be retried', 'hook', async page => {
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(() => window.oauthPort.rejectFetch(0)); await tick(page);
    assert.deepEqual(await page.evaluate(() => window.__unhandled), []);
    await expect(page.getByText('Impossible de démarrer la connexion. Réessayez.')).toBeVisible();
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page, 2);
  });

  await check('a current explicit success clears only its state and navigates internally', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER);
    await pendingFetch(page); await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' }));
    await expect(page.getByText('Compte connecté avec succès !')).toBeVisible();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), null);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_context')), null);
    await expect(page.getByTestId('path')).toHaveText('/mes-connexions');
  });

  await check('Gmail uses the same authenticated browser callback with its own purpose', 'gmail', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER);
    await pendingFetch(page);
    const request = await page.evaluate(() => ({ url: window.oauthPort.fetches[0].url,
      method: window.oauthPort.fetches[0].init.method, body: JSON.parse(window.oauthPort.fetches[0].init.body),
      authorization: new Headers(window.oauthPort.fetches[0].init.headers).get('Authorization'),
      apikey: new Headers(window.oauthPort.fetches[0].init.headers).get('apikey') }));
    assert.equal(new URL(request.url).pathname, '/functions/v1/email-agent-gmail-oauth');
    assert.equal(request.method, 'POST'); assert.equal(request.authorization, 'Bearer fixture-owner');
    assert.equal(request.apikey, 'fixture-public-key');
    assert.deepEqual(request.body, { action: 'callback', code: 'synthetic-code', state: STATE });
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/dashboard/email-agent' }));
    await expect(page.getByText('Compte connecté avec succès !')).toBeVisible();
    await expect(page.getByTestId('path')).toHaveText('/dashboard/email-agent');
  });

  await check('an older callback cannot erase a newer connection state', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    const newer = 'cd'.repeat(32);
    await page.evaluate(newer => {
      const context = JSON.parse(sessionStorage.getItem('oauth_context')); context.state = newer;
      sessionStorage.setItem('oauth_context', JSON.stringify(context)); sessionStorage.setItem('oauth_state', newer);
      window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' });
    }, newer);
    await tick(page); assert.equal(await page.getByText('Compte connecté avec succès !').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), newer);
  });

  await check('callback completion after unmount cannot notify or redirect', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(() => window.navigateFixture('/kept'));
    await expect(page.getByTestId('path')).toHaveText('/kept');
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' }));
    await page.waitForTimeout(1700); await expect(page.getByTestId('path')).toHaveText('/kept');
    assert.equal(await page.getByText('Compte connecté avec succès', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  });

  await check('StrictMode does not let an expired session read exchange the code', 'strict', async page => {
    await pendingAuth(page, 2);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await tick(page);
    assert.equal(await page.evaluate(() => window.oauthPort.fetches.length), 0);
    await page.evaluate(owner => window.oauthPort.resolveAuth(1, owner), OWNER); await pendingFetch(page);
    assert.equal(await page.evaluate(() => window.oauthPort.fetches.length), 1);
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' }));
    await expect(page.getByText('Compte connecté avec succès !')).toBeVisible();
  });

  await check('an A-B-A identity cycle never revives the first callback', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(other => window.switchIdentity(other), OTHER); await expect(page.getByTestId('account')).toHaveText(OTHER);
    await page.evaluate(owner => window.switchIdentity(owner), OWNER); await expect(page.getByTestId('account')).toHaveText(OWNER);
    await pendingAuth(page, 2);
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' }));
    await tick(page); assert.equal(await page.getByText('Compte connecté avec succès !').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  });

  await check('authorization returned after unmount cannot leave for Google', 'hook', async page => {
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(() => window.hideOAuth());
    await expect(page.getByRole('button', { name: 'Connecter Gmail' })).toHaveCount(0);
    await page.evaluate(state => window.oauthPort.resolveFetch(0, { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=' + state,
      state, expiresAt: new Date(Date.now() + 600_000).toISOString() }), 'cd'.repeat(32));
    await tick(page); assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  });

  await check('untrusted authorization destinations never replace the stored state', 'hook', async page => {
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(state => window.oauthPort.resolveFetch(0, { authUrl: 'https://foreign.fixture.invalid/?state=' + state,
      state, expiresAt: new Date(Date.now() + 600_000).toISOString() }), 'cd'.repeat(32));
    await expect(page.getByText('Impossible de démarrer la connexion. Réessayez.')).toBeVisible();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  });

  await check('connection metadata query does not request provider credentials', 'hook', async page => {
    await page.waitForFunction(() => window.oauthPort.calls.some(call => call.name === 'select'));
    const selections = await page.evaluate(() => window.oauthPort.calls.filter(call => call.name === 'select').map(call => call.value));
    assert.ok(selections.length > 0);
    for (const columns of selections) { assert.doesNotMatch(columns, /\*|access_token|refresh_token/); assert.match(columns, /token_expires_at/); }
  });

  await check('timed-out authorization releases the lock and rejects a late session', 'hook', async page => {
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page);
    await page.clock.fastForward(30_100);
    await expect(page.getByText('Impossible de démarrer la connexion. Réessayez.')).toBeVisible();
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await page.clock.runFor(10);
    assert.equal(await page.evaluate(() => window.oauthPort.fetches.length), 0);
    await page.getByRole('button', { name: 'Connecter Gmail' }).click(); await pendingAuth(page, 2);
  }, { clock: true });

  await check('a timed-out callback ignores a provider result arriving afterward', 'callback', async page => {
    await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.clock.fastForward(30_100);
    await expect(page.getByRole('heading', { name: 'Erreur', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => window.oauthPort.fetches[0].init.signal.aborted), true);
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: '/mes-connexions' }));
    await page.clock.runFor(10); assert.equal(await page.getByText('Compte connecté avec succès !').count(), 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  }, { clock: true });

  await check('callback rejects a foreign return destination despite success true', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { success: true, provider: 'gmail', returnUrl: 'https://foreign.fixture.invalid' }));
    await expect(page.getByRole('heading', { name: 'Erreur', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
  });

  await check('partial consent asks the user to review permissions without claiming success', 'callback', async page => {
    await pendingAuth(page); await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(() => window.oauthPort.resolveFetch(0, { error: 'Provider denied a requested scope' }, 403));
    await expect(page.getByRole('heading', { name: 'Erreur', exact: true })).toBeVisible();
    await expect(page.getByText('Les autorisations nécessaires n’ont pas toutes été accordées. Recommencez la connexion pour les vérifier.')).toBeVisible();
    assert.equal(await page.getByText('Compte connecté avec succès !').count(), 0);
  });

  await check('Gmail initiation stores the returned actor-bound purpose and state', 'gmail-start', async page => {
    await page.getByRole('button', { name: 'Démarrer Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    const fresh = 'cd'.repeat(32);
    await page.evaluate(state => window.oauthPort.resolveFetch(0, { url: 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=' + state,
      state, expiresAt: new Date(Date.now() + 600_000).toISOString() }), fresh);
    await page.waitForFunction(() => window.gmailResult?.url);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), fresh);
    const context = await page.evaluate(() => JSON.parse(sessionStorage.getItem('oauth_context')));
    assert.equal(context.userId, OWNER); assert.equal(context.purpose, 'email_agent_gmail'); assert.equal(context.provider, 'gmail');
    const request = await page.evaluate(() => ({ url: window.oauthPort.fetches[0].url, body: JSON.parse(window.oauthPort.fetches[0].init.body),
      apikey: new Headers(window.oauthPort.fetches[0].init.headers).get('apikey'),
      authorization: new Headers(window.oauthPort.fetches[0].init.headers).get('Authorization') }));
    assert.equal(new URL(request.url).pathname, '/functions/v1/email-agent-gmail-oauth'); assert.deepEqual(request.body, { action: 'start' });
    assert.equal(request.apikey, 'fixture-public-key'); assert.equal(request.authorization, 'Bearer fixture-owner');
  });

  await check('Gmail initiation rejects a foreign URL without replacing the prior state', 'gmail-start', async page => {
    await page.getByRole('button', { name: 'Démarrer Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(state => window.oauthPort.resolveFetch(0, { url: 'https://foreign.fixture.invalid/?state=' + state,
      state, expiresAt: new Date(Date.now() + 600_000).toISOString() }), 'cd'.repeat(32));
    await page.waitForFunction(() => window.gmailResult?.error);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
    assert.equal(await page.evaluate(() => window.gmailResult.url), undefined);
  });

  await check('cancelled Gmail initiation cannot store a late response', 'gmail-start', async page => {
    await page.getByRole('button', { name: 'Démarrer Gmail' }).click(); await pendingAuth(page);
    await page.evaluate(owner => window.oauthPort.resolveAuth(0, owner), OWNER); await pendingFetch(page);
    await page.evaluate(() => window.abortGmail()); await page.waitForFunction(() => window.gmailResult?.error);
    await page.evaluate(state => window.oauthPort.resolveFetch(0, { url: 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=' + state,
      state, expiresAt: new Date(Date.now() + 600_000).toISOString() }), 'cd'.repeat(32));
    await tick(page); assert.equal(await page.evaluate(() => sessionStorage.getItem('oauth_state')), STATE);
    assert.equal(await page.evaluate(() => window.gmailResult.url), undefined);
  });
} catch (error) { result.fatal = error.stack; }
finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  result.sourcesAfter = await hashes(); result.sourceUnchanged = JSON.stringify(result.sources) === JSON.stringify(result.sourcesAfter);
  result.finishedAt = new Date().toISOString();
  result.status = !result.fatal && result.sourceUnchanged && result.checks.length > 0 && result.checks.every(x => x.status === 'PASS') ? 'PASS' : 'FAIL';
  await checkpoint(); console.log(JSON.stringify({ status: result.status, checks: result.checks.length,
    pass: result.checks.filter(x => x.status === 'PASS').length, fail: result.checks.filter(x => x.status === 'FAIL').length, fatal: result.fatal }));
  if (result.status !== 'PASS') process.exitCode = 1;
}
