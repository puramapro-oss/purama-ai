/* global process */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2] || path.join(here, '../../..'));
const evidence = path.resolve(process.env.CONTRACTS_OTS_BROWSER_EVIDENCE || path.join(here, 'evidence'));
const adminOverride = process.env.CONTRACTS_OTS_ADMIN_SOURCE && path.resolve(process.env.CONTRACTS_OTS_ADMIN_SOURCE);
const require = createRequire(path.join(source, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const sourceFiles = [
  'src/pages/AdminContracts.tsx',
  'src/components/auth/ProtectedRoute.tsx',
  'src/hooks/useRequestScope.ts',
];
const digest = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
  file,
  createHash('sha256').update(await readFile(file === sourceFiles[0] && adminOverride ? adminOverride : path.join(source, file))).digest('hex'),
])));
const result = {
  startedAt: new Date().toISOString(),
  source,
  adminOverride: adminOverride || null,
  sourceSha256: await digest(),
  node: process.version,
  backend: 'simulated',
  authentication: 'simulated',
  mounted: ['AdminContracts', 'ProtectedRoute', 'useRequestScope', 'React 18', 'MemoryRouter', 'Sonner'],
  externalRequests: [],
  pageErrors: [],
  checks: [],
};
let server, browser, origin;
const row = (page, account, name = 'ONE') => page.getByRole('row').filter({ hasText: 'CONTRACT_' + account + '_' + name });
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const notices = page => page.evaluate(() => window.__notices);
const successes = entries => entries.filter(entry => entry.level === 'success');
const pendingNotices = entries => entries.filter(entry => /attente de confirmation Bitcoin/i.test(entry.text));
async function switchAccount(page, id) {
  await page.evaluate(id => window.__setUser(id), id);
  await expect(page.getByTestId('account')).toHaveText(id);
  await expect(row(page, id)).toBeVisible();
}
async function verify(page, account, name = 'ONE') {
  const previous = await page.evaluate(() => window.__otsCalls.length);
  await row(page, account, name).getByRole('button').last().click();
  await page.waitForFunction(previous => window.__otsCalls.length === previous + 1, previous);
  return page.evaluate(() => window.__otsCalls.at(-1).id);
}
async function resolveOts(page, id, response) {
  await page.evaluate(({ id, response }) => window.__resolveOts(id, response), { id, response });
  await tick(page);
}
const confirmed = height => ({ status: 200, body: { verified: true, block_height: height, btc_timestamp: '2024-04-20T00:09:27.000Z' } });
async function check(name, action) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && ['GET', 'HEAD'].includes(route.request().method())) return route.continue();
    result.externalRequests.push(url.origin);
    return route.abort();
  });
  await context.routeWebSocket('**/*', route => {
    const url = new URL(route.url());
    if (url.origin !== origin.replace('http:', 'ws:')) result.externalRequests.push(url.origin);
    route.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => result.pageErrors.push({ name, message: error.message }));
  try {
    await page.goto(origin);
    await expect(row(page, 'A')).toBeVisible();
    await action(page);
    result.checks.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (error) {
    result.checks.push({ name, status: 'FAIL', message: error.message });
    console.error('FAIL ' + name + ': ' + error.message);
  } finally {
    await context.close();
  }
}
try {
  const aliases = {
    '@/integrations/supabase/client': path.join(here, 'backend.js'),
    '@/hooks/useAuth': path.join(source, 'tests/quality/account-isolation/auth.jsx'),
    '@': path.join(source, 'src'),
  };
  if (adminOverride) aliases['@/pages/AdminContracts'] = adminOverride;
  const built = await build({
    entryPoints: [path.join(here, 'entry.jsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    nodePaths: [path.join(source, 'node_modules')],
    define: {
      'process.env.NODE_ENV': '"test"',
      'import.meta.env.VITE_SUPABASE_URL': '"https://supabase.fixture.invalid"',
    },
    alias: aliases,
  });
  const bundle = built.outputFiles[0].contents;
  result.bundleBytes = bundle.length;
  result.bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  browser = await chromium.launch({ headless: true, args: ['--no-zygote', '--disable-gpu', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'], ...(executablePath ? { executablePath } : {}) });
  result.browser = browser.version();

  await check('mounted current verification displays the confirmed block', async page => {
    const request = await verify(page, 'A');
    await resolveOts(page, request, confirmed(840000));
    await expect(row(page, 'A').getByText('#840000', { exact: true })).toBeVisible();
    assert.equal(successes(await notices(page)).length, 1);
  });
  await check('mounted pending proof remains a distinct successful pending response', async page => {
    const request = await verify(page, 'A');
    await resolveOts(page, request, { status: 200, body: { verified: false, pending: true } });
    const events = await notices(page);
    assert.equal(pendingNotices(events).length, 1);
    assert.equal(successes(events).length, 0);
    assert.equal(events.filter(entry => entry.level === 'error').length, 0);
  });
  await check('mounted HTTP error never becomes a pending Bitcoin confirmation', async page => {
    const request = await verify(page, 'A');
    await resolveOts(page, request, { status: 403, body: { error: 'fixture access revoked' } });
    const events = await notices(page);
    assert.equal(events.filter(entry => entry.level === 'error').length, 1);
    assert.equal(pendingNotices(events).length, 0);
    assert.equal(successes(events).length, 0);
  });
  await check('account remount rejects a late proof while the new account still works', async page => {
    const previous = await verify(page, 'A');
    await switchAccount(page, 'B');
    assert.equal(await row(page, 'A').count(), 0);
    const current = await verify(page, 'B');
    await resolveOts(page, current, confirmed(840001));
    await expect(row(page, 'B').getByText('#840001', { exact: true })).toBeVisible();
    const before = await notices(page);
    await resolveOts(page, previous, confirmed(999991));
    assert.deepEqual(await notices(page), before);
    assert.equal(await page.getByText('#999991', { exact: true }).count(), 0);
    await expect(row(page, 'B').getByText('#840001', { exact: true })).toBeVisible();
  });
  await check('contract selection invalidates an earlier proof response', async page => {
    const request = await verify(page, 'A');
    await row(page, 'A', 'TWO').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const before = await notices(page);
    await resolveOts(page, request, confirmed(999992));
    assert.deepEqual(await notices(page), before);
    assert.equal(await page.getByText('#999992', { exact: true }).count(), 0);
  });
  await check('account change during session acquisition prevents the old request', async page => {
    await page.evaluate(() => { window.__deferSession = true; });
    await row(page, 'A').getByRole('button').last().click();
    await page.waitForFunction(() => window.__sessions.length === 1);
    await switchAccount(page, 'B');
    await page.evaluate(() => window.__resolveSession());
    await tick(page);
    assert.equal(await page.evaluate(() => window.__otsCalls.length), 0);
    assert.equal((await notices(page)).length, 0);
  });
  await check('A-B-A remount never admits the first lifetime proof response', async page => {
    const stale = await verify(page, 'A');
    await switchAccount(page, 'B');
    await switchAccount(page, 'A');
    const before = await notices(page);
    await resolveOts(page, stale, confirmed(999993));
    assert.deepEqual(await notices(page), before);
    assert.equal(await row(page, 'A').getByText('#999993', { exact: true }).count(), 0);
  });
} catch (error) {
  result.fatal = error.stack || String(error);
} finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  result.finishedAt = new Date().toISOString();
  result.sourceSha256After = await digest();
  result.sourceUnchanged = JSON.stringify(result.sourceSha256) === JSON.stringify(result.sourceSha256After);
  result.status = !result.fatal && result.checks.length === 7 && result.checks.every(check => check.status === 'PASS')
    && result.sourceUnchanged && result.externalRequests.length === 0 && result.pageErrors.length === 0 ? 'PASS' : 'FAIL';
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    status: result.status,
    pass: result.checks.filter(check => check.status === 'PASS').length,
    fail: result.checks.filter(check => check.status === 'FAIL').length,
    sourceUnchanged: result.sourceUnchanged,
    pageErrors: result.pageErrors,
    externalRequests: result.externalRequests,
    fatal: result.fatal,
  }));
  if (result.status !== 'PASS') process.exitCode = 1;
}
