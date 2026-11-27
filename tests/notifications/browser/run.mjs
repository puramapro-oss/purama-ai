import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2] || path.join(here, '../../..'));
const evidence = path.resolve(process.env.NOTIFICATIONS_BROWSER_EVIDENCE || path.join(source, 'qa/notifications-20261127/browser-final'));
const prebuilt = process.env.NOTIFICATIONS_BROWSER_PREBUILT ? path.resolve(process.env.NOTIFICATIONS_BROWSER_PREBUILT) : null;
const manifest = prebuilt ? JSON.parse(await readFile(path.join(prebuilt, 'manifest.json'), 'utf8')) : null;
const require = createRequire(path.join(process.env.NOTIFICATIONS_BROWSER_DEPENDENCIES || source, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const sourceFiles = ['src/hooks/useNotifications.ts', 'src/hooks/useRequestScope.ts',
  'supabase/functions/_shared/notification-action-url.ts', 'src/lib/safeNavigation.ts', 'src/pages/Notifications.tsx',
  'src/pages/NotificationSettings.tsx', 'src/components/notifications/NotificationCenter.tsx',
  'src/components/dashboard/DashboardHeader.tsx', 'src/index.css', 'src/fonts.css', 'tailwind.config.ts'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(path.join(source, file)))])));
const artifactHashes = async () => Object.fromEntries(await Promise.all(Object.keys(manifest.files).map(async file => {
  const target = path.resolve(prebuilt, file);
  assert.ok(target.startsWith(prebuilt + path.sep), 'Artifact file must remain inside its directory');
  return [file, digest(await readFile(target))];
})));
const result = { status: 'RUNNING', startedAt: new Date().toISOString(), source: manifest?.source || source,
  sourceSha256: manifest?.sourceSha256 || await hashes(),
  executionMode: prebuilt ? 'verified precompiled artifact; remote source files not inspected' : 'bundle built from current source files',
  artifactManifest: manifest,
  node: process.version, backend: 'controlled in-memory Supabase and authentication fixtures',
  reactQueryAndSonner: 'real installed packages', checks: [], pageErrors: [], externalRequests: [], screenshots: [] };
let server, browser, origin;
const checkpoint = async () => { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n'); };
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const row = (owner, id, title, action = '/dashboard') => ({ id, user_id: owner, type: 'alert', title,
  message: 'Message synthétique de recette', agent_slug: 'assistant', read: false, action_url: action,
  created_at: '2026-11-27T00:00:00Z' });
const prefs = (owner, email = false) => ({ id: `prefs-${owner}`, user_id: owner, email_enabled: email,
  task_completed_enabled: false, question_enabled: true, daily_report_enabled: false, alert_enabled: true,
  created_at: '2026-11-27T00:00:00Z', updated_at: '2026-11-27T00:00:00Z' });
const fixture = (page, action, args = []) => page.evaluate(({ action, args }) => window.__notificationFixture[action](...args), { action, args });
const account = async (page, owner) => {
  await page.getByRole('button', { name: owner ? `Compte ${owner} (banc)` : 'Déconnexion (banc)', exact: true }).click();
  await expect(page.getByTestId('fixture-account')).toHaveText(owner ?? 'anonymous');
  await tick(page);
};
const activeChannel = async (page, owner) => {
  await page.waitForFunction(owner => window.__notificationFixture.snapshot().channels.some(channel =>
    !channel.removed && channel.filters.some(filter => filter.filter === `user_id=eq.${owner}`)), owner);
  return (await fixture(page, 'snapshot')).channels.find(channel => !channel.removed && channel.filters.some(filter => filter.filter === `user_id=eq.${owner}`)).id;
};
const toasts = page => page.locator('[data-sonner-toast]');
const snapshot = async (page, name) => {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(evidence, name), fullPage: true, animations: 'disabled' });
  result.screenshots.push(name);
};

async function check(name, view, scenario, action) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && ['GET', 'HEAD'].includes(route.request().method())) return route.continue();
    result.externalRequests.push({ name, url: url.origin, method: route.request().method() });
    return route.abort();
  });
  await context.routeWebSocket('**/*', route => { result.externalRequests.push({ name, websocket: new URL(route.url()).origin }); route.close(); });
  await context.addInitScript(value => { window.__notificationScenario = value; }, scenario);
  const page = await context.newPage();
  page.setDefaultTimeout(6500);
  page.on('pageerror', error => result.pageErrors.push({ name, message: error.message }));
  try {
    await page.goto(`${origin}/?view=${view}`);
    await expect(page.getByTestId('fixture-account')).toHaveText(scenario.owner ?? 'A');
    const observed = await action(page);
    result.checks.push({ name, status: 'PASS', ...observed });
    console.log(`PASS ${name}`);
  } catch (error) {
    const screenshot = `failure-${result.checks.length + 1}.png`;
    await snapshot(page, screenshot).catch(() => {});
    result.checks.push({ name, status: 'FAIL', message: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); await checkpoint(); }
}

try {
  let bundle, css;
  const fontAssets = new Map();
  if (prebuilt) {
    result.artifactSha256 = await artifactHashes();
    assert.deepEqual(result.artifactSha256, manifest.files, 'Precompiled artifact integrity');
    assert.equal(digest(await readFile(fileURLToPath(import.meta.url))), manifest.files['run.mjs'], 'Runner must match the precompiled artifact');
    bundle = await readFile(path.join(prebuilt, 'bundle.js'));
    css = await readFile(path.join(prebuilt, 'style.css'), 'utf8');
    for (const name of Object.keys(manifest.files).filter(name => /^fonts\/[^/]+\.woff2$/.test(name))) {
      fontAssets.set(path.basename(name), await readFile(path.join(prebuilt, name)));
    }
  } else {
    const { build } = require('esbuild');
    const postcss = require('postcss');
    const tailwind = require('tailwindcss');
    const alias = { '@/hooks/useAuth': path.join(here, 'auth.jsx'), '@/hooks/useProfile': path.join(here, 'support.jsx'),
      '@/hooks/useAgents': path.join(here, 'support.jsx'), '@/integrations/supabase/client': path.join(here, 'supabase.js'),
      '@': path.join(source, 'src') };
    const built = await build({ entryPoints: [path.join(here, 'entry.jsx')], bundle: true, write: false,
      platform: 'browser', format: 'iife', jsx: 'automatic', alias,
      nodePaths: [path.join(source, 'node_modules')], define: { 'process.env.NODE_ENV': '"test"' } });
    bundle = built.outputFiles[0].contents;
    const { default: tailwindConfig } = await import(pathToFileURL(path.join(source, 'tailwind.config.ts')).href);
    const cssSource = (await readFile(path.join(source, 'src/index.css'), 'utf8')).replace("@import './fonts.css';", await readFile(path.join(source, 'src/fonts.css'), 'utf8'));
    css = (await postcss([tailwind({ ...tailwindConfig, content: [path.join(source, 'src/**/*.{ts,tsx}')] })]).process(cssSource, { from: path.join(source, 'src/index.css') })).css;
    for (const name of await readdir(path.join(source, 'src/assets/fonts'))) {
      if (name.endsWith('.woff2')) fontAssets.set(name, await readFile(path.join(source, 'src/assets/fonts', name)));
    }
  }
  const assets = new Map([['/bundle.js', { type: 'text/javascript', body: bundle }], ['/style.css', { type: 'text/css', body: css }]]);
  for (const [name, bytes] of fontAssets) assets.set(`/assets/fonts/${name}`, { type: 'font/woff2', body: bytes });
  result.bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  result.cssSha256 = createHash('sha256').update(css).digest('hex');
  result.browserPackage = require('@playwright/test/package.json').version;
  await checkpoint();
  if (process.env.NOTIFICATIONS_BROWSER_BUILD_ONLY === '1') {
    await writeFile(path.join(evidence, 'bundle.js'), bundle);
    await writeFile(path.join(evidence, 'style.css'), css);
    await copyFile(fileURLToPath(import.meta.url), path.join(evidence, 'run.mjs'));
    await mkdir(path.join(evidence, 'fonts'), { recursive: true });
    for (const [name, bytes] of fontAssets) await writeFile(path.join(evidence, 'fonts', name), bytes);
    const files = { 'bundle.js': digest(bundle), 'style.css': digest(css), 'run.mjs': digest(await readFile(fileURLToPath(import.meta.url))),
      ...Object.fromEntries([...fontAssets].map(([name, bytes]) => [`fonts/${name}`, digest(bytes)])) };
    await writeFile(path.join(evidence, 'manifest.json'), JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(),
      source, sourceSha256: result.sourceSha256, sourcePlaywrightVersion: result.browserPackage, files,
      isolation: 'Loopback static server; inert synthetic auth/DB/Realtime fixtures; actual React/QueryClient/Sonner and product components; no external requests allowed' }, null, 2) + '\n');
    result.buildOnly = true;
  } else {
    server = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const asset = assets.get(pathname);
      res.setHeader('Cache-Control', 'no-store');
      if (asset) { res.setHeader('Content-Type', asset.type); res.end(asset.body); return; }
      if (pathname !== '/') { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();
    await access(executablePath);
    result.executablePath = executablePath;
    browser = await chromium.launch({ headless: true, executablePath,
      args: ['--disable-dev-shm-usage', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    result.browserVersion = browser.version();

    await check('real list renders owned notification and safe link on desktop and mobile', 'notifications',
      { rows: { A: [row('A', 'safe', 'Votre rendez-vous est confirmé', '/dashboard?notification=safe')] } }, async page => {
        await expect(page.getByText('Votre rendez-vous est confirmé', { exact: true })).toBeVisible();
        await expect(page.locator('a[href="/dashboard?notification=safe"]')).toHaveCount(1);
        await snapshot(page, 'desktop-notifications.png');
        await page.setViewportSize({ width: 390, height: 844 });
        await snapshot(page, 'mobile-notifications.png');
        return { viewport: ['1365x900', '390x844'], productionComponents: ['Notifications', 'DashboardHeader', 'NotificationCenter'] };
      });

    await check('list failure is distinct from empty and retry filters non-owned rows', 'notifications',
      { rows: { A: [row('B', 'foreign', 'PRIVATE_B_ROW'), { ...row('A', 'invalid', 'INVALID_DATE_ROW'), created_at: 'bad-date' }, row('A', 'valid', 'CURRENT_A_ROW')] },
        rules: [{ table: 'notifications', action: 'select', mode: 'error' }] }, async page => {
        await expect(page.getByTestId('product-surface').getByRole('alert')).toBeVisible();
        await expect(page.getByText('Toutes les notifications sont lues', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Aucune notification', exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
        await expect(page.getByText('CURRENT_A_ROW', { exact: true })).toBeVisible();
        await expect(page.getByText('PRIVATE_B_ROW', { exact: true })).toHaveCount(0);
        await expect(page.getByText('INVALID_DATE_ROW', { exact: true })).toHaveCount(0);
      });

    await check('unsafe historical navigation is removed from real rendered links', 'notifications',
      { rows: { A: [row('A', 'unsafe', 'Lien ancien neutralisé', 'javascript:window.__executed=true'), row('A', 'unsafe2', 'Lien externe neutralisé', '//evil.example.test/path')] } }, async page => {
        await expect(page.getByText('Lien ancien neutralisé', { exact: true })).toBeVisible();
        await expect(page.locator('a[href^="javascript:"],a[href^="data:"],a[href*="evil.example.test"]')).toHaveCount(0);
        assert.equal(await page.evaluate(() => window.__executed), undefined);
      });

    await check('real notification popover distinguishes errors and recovers with safe content', 'center',
      { rows: { A: [row('A', 'popover', 'Notification du centre', 'javascript:alert(1)')] },
        rules: [{ table: 'notifications', action: 'select', mode: 'error' }] }, async page => {
        await page.getByTestId('product-surface').getByRole('button').first().click();
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(page.getByText('Aucune notification', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
        await expect(page.getByText('Notification du centre', { exact: true })).toBeVisible();
        await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
      });

    await check('real Sonner notification is dismissed when the account changes', 'notifications', { rows: { A: [], B: [] } }, async page => {
      const id = await activeChannel(page, 'A');
      await fixture(page, 'emit', [id, row('A', 'live', 'PRIVATE_A_TOAST')]);
      await expect(toasts(page).filter({ hasText: 'PRIVATE_A_TOAST' })).toBeVisible();
      await account(page, 'B');
      await expect(toasts(page).filter({ hasText: 'PRIVATE_A_TOAST' })).toHaveCount(0);
      const state = await fixture(page, 'snapshot');
      assert.ok(state.channels.every(channel => channel.filters.every(filter => filter.schema === 'purama_ai')));
      assert.equal(new Set(state.channels.map(channel => channel.name)).size, state.channels.length);
      return { schema: 'purama_ai', uniqueChannels: state.channels.length };
    });

    await check('logout dismisses visible private notification toasts', 'notifications', { rows: { A: [] } }, async page => {
      await fixture(page, 'emit', [await activeChannel(page, 'A'), row('A', 'logout', 'PRIVATE_LOGOUT_TOAST')]);
      await expect(toasts(page).filter({ hasText: 'PRIVATE_LOGOUT_TOAST' })).toBeVisible();
      await account(page, null);
      await expect(toasts(page).filter({ hasText: 'PRIVATE_LOGOUT_TOAST' })).toHaveCount(0);
      assert.ok((await fixture(page, 'snapshot')).channels.every(channel => channel.removed));
    });

    await check('late A callback remains rejected after an A-B-A account cycle', 'notifications', { rows: { A: [], B: [] } }, async page => {
      const old = await activeChannel(page, 'A');
      await account(page, 'B'); await activeChannel(page, 'B'); await account(page, 'A');
      const current = await activeChannel(page, 'A'); assert.notEqual(current, old);
      await fixture(page, 'emit', [old, row('A', 'old', 'STALE_A_CALLBACK')]);
      await tick(page); await expect(toasts(page).filter({ hasText: 'STALE_A_CALLBACK' })).toHaveCount(0);
      await fixture(page, 'emit', [current, row('A', 'new', 'CURRENT_A_CALLBACK')]);
      await expect(toasts(page).filter({ hasText: 'CURRENT_A_CALLBACK' })).toBeVisible();
    });

    await check('Realtime rejects foreign rows and removes unsafe toast action', 'notifications', { rows: { A: [] } }, async page => {
      const id = await activeChannel(page, 'A');
      await fixture(page, 'emit', [id, row('B', 'foreign', 'FOREIGN_REALTIME')]);
      await fixture(page, 'emit', [id, { ...row('A', 'malformed', 'MALFORMED_REALTIME'), type: 'unknown' }]);
      await fixture(page, 'emit', [id, row('A', 'safe-body', 'CURRENT_WITH_UNSAFE_URL', 'javascript:alert(1)')]);
      await expect(toasts(page).filter({ hasText: 'CURRENT_WITH_UNSAFE_URL' })).toBeVisible();
      await expect(toasts(page).filter({ hasText: 'FOREIGN_REALTIME' })).toHaveCount(0);
      await expect(toasts(page).filter({ hasText: 'MALFORMED_REALTIME' })).toHaveCount(0);
      await expect(toasts(page).filter({ hasText: 'CURRENT_WITH_UNSAFE_URL' }).getByRole('button', { name: 'Voir', exact: true })).toHaveCount(0);
    });

    await check('real preference switches show confirmed false and persist a requested change', 'settings',
      { rows: { A: [] }, preferences: { A: prefs('A', false) } }, async page => {
        const email = page.getByRole('switch', { name: 'Activer les emails', exact: true });
        await expect(email).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByRole('switch', { name: 'Tâches terminées', exact: true })).toHaveAttribute('aria-checked', 'false');
        await snapshot(page, 'desktop-preferences.png');
        await page.setViewportSize({ width: 390, height: 844 }); await snapshot(page, 'mobile-preferences.png');
        await email.click(); await expect(email).toHaveAttribute('aria-checked', 'true');
        await expect(toasts(page).filter({ hasText: 'Préférences mises à jour' })).toBeVisible();
        const saves = (await fixture(page, 'snapshot')).calls.filter(call => call.action === 'upsert');
        assert.equal(saves.length, 1); assert.deepEqual(saves[0].value, { email_enabled: true, user_id: 'A' });
      });

    await check('failed preference save preserves confirmed state and a later retry succeeds', 'settings',
      { rows: { A: [] }, preferences: { A: prefs('A', false) }, rules: [{ table: 'notification_preferences', action: 'upsert', mode: 'error' }] }, async page => {
        const email = page.getByRole('switch', { name: 'Activer les emails', exact: true });
        await expect(email).toHaveAttribute('aria-checked', 'false'); await email.click();
        await expect(toasts(page).filter({ hasText: 'Impossible de modifier les préférences' })).toBeVisible();
        await expect(email).toHaveAttribute('aria-checked', 'false');
        await email.click(); await expect(email).toHaveAttribute('aria-checked', 'true');
        const saves = (await fixture(page, 'snapshot')).calls.filter(call => call.action === 'upsert');
        assert.equal(saves.length, 2);
      });

    await check('preference load failure does not present enabled defaults and can recover', 'settings',
      { rows: { A: [] }, preferences: { A: prefs('A', false) }, rules: [{ table: 'notification_preferences', action: 'select', mode: 'error' }] }, async page => {
        await expect(toasts(page).filter({ hasText: 'Impossible de charger les préférences' })).toBeVisible();
        const misleading = await page.getByRole('switch').evaluateAll(nodes => nodes.filter(node => node.getAttribute('aria-checked') === 'true' && !node.disabled).length);
        await snapshot(page, 'preferences-load-error.png');
        await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
        await expect(page.getByRole('switch', { name: 'Activer les emails', exact: true })).toHaveAttribute('aria-checked', 'false');
        assert.equal(misleading, 0, 'Unavailable preferences must not appear as enabled editable defaults');
        return { recovered: true, misleadingEnabledControlsDuringFailure: misleading };
      });

    await check('a late list response for A never replaces the visible B list', 'notifications',
      { rows: { A: [row('A', 'old-row', 'LATE_PRIVATE_A')], B: [row('B', 'current-row', 'CURRENT_PRIVATE_B')] },
        rules: [{ table: 'notifications', action: 'select', mode: 'hold' }] }, async page => {
        await page.waitForFunction(() => window.__notificationFixture.snapshot().held.length === 1);
        const [heldId] = (await fixture(page, 'snapshot')).held;
        await account(page, 'B'); await expect(page.getByText('CURRENT_PRIVATE_B', { exact: true })).toBeVisible();
        await fixture(page, 'resolve', [heldId]); await tick(page);
        await expect(page.getByText('LATE_PRIVATE_A', { exact: true })).toHaveCount(0);
        await expect(page.getByText('CURRENT_PRIVATE_B', { exact: true })).toBeVisible();
      });
  }
} catch (error) { result.fatal = error.stack; }
finally {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  result.finishedAt = new Date().toISOString();
  if (prebuilt) {
    result.artifactSha256After = await artifactHashes();
    result.artifactUnchanged = JSON.stringify(result.artifactSha256) === JSON.stringify(result.artifactSha256After);
    result.sourceUnchanged = null;
  } else {
    result.sourceSha256After = await hashes();
    result.sourceUnchanged = JSON.stringify(result.sourceSha256) === JSON.stringify(result.sourceSha256After);
  }
  result.status = result.buildOnly && !result.fatal ? 'BUILD_ONLY_NON_TESTE' :
    !result.fatal && (prebuilt ? result.artifactUnchanged : result.sourceUnchanged) && result.checks.length === 12 && result.checks.every(check => check.status === 'PASS') &&
    !result.pageErrors.length && !result.externalRequests.length ? 'PASS' : 'FAIL';
  await checkpoint();
  console.log(JSON.stringify({ status: result.status, passed: result.checks.filter(check => check.status === 'PASS').length,
    failed: result.checks.filter(check => check.status === 'FAIL').length, pageErrors: result.pageErrors,
    externalRequests: result.externalRequests, sourceUnchanged: result.sourceUnchanged, fatal: result.fatal }));
  if (result.status === 'FAIL') process.exitCode = 1;
}
