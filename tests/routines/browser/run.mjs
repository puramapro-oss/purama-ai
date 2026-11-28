import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { chromium, expect } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../..');
const evidence = path.resolve(process.env.ROUTINES_BROWSER_EVIDENCE || path.join(source, 'qa/iao-calls-routines-20261128/browser'));
const files = ['src/lib/iao-routines-client.ts', 'src/hooks/useIaoRoutines.ts', 'src/hooks/useRequestScope.ts',
  'src/components/notifications/IaoRoutinesSettings.tsx', 'karta/src/routines/contracts.ts', 'karta/src/routines/schedule.ts'];
const digest = data => createHash('sha256').update(data).digest('hex');
const result = { status: 'RUNNING', startedAt: new Date().toISOString(), node: process.version,
  sources: Object.fromEntries(await Promise.all(files.map(async name => [name, digest(await readFile(path.join(source, name)))]))),
  backend: 'Synthetic authenticated routine service; no database, provider or telephone qualification',
  tests: [], pageErrors: [], externalRequests: [], screenshots: [] };
await mkdir(evidence, { recursive: true });
const checkpoint = () => writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n');
let browser, server, origin;

async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(evidence, name), fullPage: true, animations: 'disabled' });
  result.screenshots.push(name);
}
async function scenario(name, options, test) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin && route.request().method() === 'GET') return route.continue();
    result.externalRequests.push({ test: name, method: route.request().method(), origin: new URL(route.request().url()).origin });
    return route.abort();
  });
  await context.routeWebSocket('**/*', socket => { result.externalRequests.push({ test: name, websocket: true }); socket.close(); });
  await context.addInitScript(config => { window.__routineScenario = config; }, options);
  const page = await context.newPage(); page.setDefaultTimeout(6500);
  page.on('pageerror', error => result.pageErrors.push({ test: name, message: error.message }));
  try {
    await page.goto(origin);
    await test(page);
    result.tests.push({ name, status: 'PASS' }); console.log(`PASS ${name}`);
  } catch (error) {
    result.tests.push({ name, status: 'FAIL', message: error.message }); console.error(`FAIL ${name}: ${error.message}`);
    await screenshot(page, `failure-${result.tests.length}.png`).catch(() => {});
  } finally { await context.close(); await checkpoint(); }
}

try {
  const bundle = await build({ entryPoints: [path.join(here, 'entry.tsx')], bundle: true, write: false, platform: 'browser',
    format: 'iife', jsx: 'automatic', alias: { '@/integrations/supabase/client': path.join(here, 'fixture.ts'), '@': path.join(source, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' } });
  const { default: config } = await import(pathToFileURL(path.join(source, 'tailwind.config.ts')));
  const cssSource = (await readFile(path.join(source, 'src/index.css'), 'utf8')).replace("@import './fonts.css';", await readFile(path.join(source, 'src/fonts.css'), 'utf8'));
  const cssFiles = ['src/components/notifications/IaoRoutinesSettings.tsx', ...['button', 'card', 'checkbox', 'input', 'label', 'skeleton', 'switch', 'textarea'].map(name => `src/components/ui/${name}.tsx`)];
  const css = (await postcss([tailwind({ ...config, content: [...cssFiles.map(name => path.join(source, name)), path.join(here, 'entry.tsx')] })]).process(cssSource, { from: path.join(source, 'src/index.css') })).css;
  const assets = new Map([['/bundle.js', { type: 'text/javascript', body: bundle.outputFiles[0].contents }], ['/style.css', { type: 'text/css', body: css }]]);
  for (const font of await readdir(path.join(source, 'src/assets/fonts'))) if (font.endsWith('.woff2')) {
    assets.set(`/assets/fonts/${font}`, { type: 'font/woff2', body: await readFile(path.join(source, 'src/assets/fonts', font)) });
  }
  result.bundleSha256 = digest(bundle.outputFiles[0].contents);
  result.styleSha256 = digest(css);
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const asset = assets.get(pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (asset) { res.setHeader('Content-Type', asset.type); res.end(asset.body); return; }
    if (pathname !== '/') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/usr/bin/chromium', headless: true,
    args: ['--disable-dev-shm-usage', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  result.browser = browser.version();

  await scenario('Create, preview, activate, pause and inspect the same routine', {}, async page => {
    await expect(page.getByText('Aucune routine enregistrée.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Bilan du matin', exact: true }).click();
    await page.getByLabel('Nom de la routine', { exact: true }).fill('Mon bilan personnalisé');
    await expect(page.getByRole('button', { name: 'Enregistrer et activer', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Vérifier les prochaines occurrences' }).click();
    await expect(page.getByRole('list').filter({ has: page.locator('li', { hasText: 'nov.' }) })).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer et activer', exact: true }).click();
    await expect(page.getByText('Routine enregistrée et activée.', { exact: true })).toBeVisible();
    const payloads = await page.evaluate(() => window.__routineFixture.snapshot().requests.filter(row => row.action === 'save'));
    assert.equal(payloads.length, 1); assert.equal(payloads[0].body.expectedRevision, 0);
    assert.equal(typeof payloads[0].body.id, 'string'); assert.equal('userId' in payloads[0].body, false);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.getByRole('button', { name: 'Mettre en pause Mon bilan personnalisé', exact: true }).click();
    await expect(page.getByText('En pause', { exact: true })).toBeVisible();
    await screenshot(page, 'desktop-routine-paused.png');
  });

  await scenario('Mobile editor exposes real choices without activating an unavailable phone', {}, async page => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Créer une routine', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Appel téléphonique', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Notification', exact: true }).check();
    await page.getByLabel('Quand ?', { exact: true }).selectOption('weekly');
    await page.getByRole('button', { name: 'Samedi', exact: true }).click();
    await page.getByLabel('Si plusieurs canaux sont sélectionnés', { exact: true }).selectOption('fallback');
    await page.getByRole('button', { name: 'Faire passer Appel téléphonique plus tôt', exact: true }).click();
    await expect(page.getByText('Appels à configurer', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Vérifier les prochaines occurrences' }).click();
    await expect(page.getByRole('button', { name: 'Enregistrer et activer', exact: true })).toBeDisabled();
    await page.getByRole('switch', { name: 'Activer après l’enregistrement', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Enregistrer en pause', exact: true }).click();
    await expect(page.getByText('Routine enregistrée en pause.', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await screenshot(page, 'mobile-routine-editor.png');
    await page.evaluate(() => document.documentElement.classList.add('light'));
    await screenshot(page, 'mobile-routine-editor-light.png');
  });

  await scenario('Changing settings invalidates an earlier preview', {}, async page => {
    await page.getByRole('button', { name: 'Créer une routine', exact: true }).click();
    await page.getByRole('button', { name: 'Vérifier les prochaines occurrences' }).click();
    await expect(page.getByRole('button', { name: 'Enregistrer et activer', exact: true })).toBeEnabled();
    await page.getByLabel('Heure locale', { exact: true }).fill('09:15');
    await expect(page.getByRole('button', { name: 'Enregistrer et activer', exact: true })).toBeDisabled();
    assert.equal((await page.evaluate(() => window.__routineFixture.snapshot().requests)).filter(row => row.action === 'save').length, 0);
  });

  await scenario('An ambiguous request is not automatically repeated and keeps its identity', { seeded: true, ambiguousRun: true }, async page => {
    await page.getByRole('button', { name: 'Recevoir maintenant — Bilan privé A', exact: true }).click();
    await expect(page.getByText('Aucun nouvel envoi n’est lancé automatiquement.', { exact: true })).toBeVisible();
    let requests = await page.evaluate(() => window.__routineFixture.snapshot().requests.filter(row => row.action === 'run-now'));
    assert.equal(requests.length, 1);
    await page.getByRole('button', { name: 'Vérifier la demande — Bilan privé A', exact: true }).click();
    await expect(page.getByText('Derniers envois', { exact: true })).toBeVisible();
    requests = await page.evaluate(() => window.__routineFixture.snapshot().requests.filter(row => row.action === 'run-now'));
    assert.equal(requests.length, 2); assert.equal(requests[0].body.requestId, requests[1].body.requestId);
    await page.getByRole('button', { name: 'Annuler les envois en attente', exact: true }).click();
    await expect(page.getByText('Les envois encore en attente sont annulés. Un appel déjà transmis peut continuer.', { exact: true })).toBeVisible();
    await expect(page.getByText('Annulé', { exact: true })).toBeVisible();
    await screenshot(page, 'desktop-delivery-history.png');
  });

  await scenario('Account changes discard private drafts and late save responses', { seeded: true }, async page => {
    await page.getByRole('button', { name: 'Modifier Bilan privé A', exact: true }).click();
    await page.getByLabel('Nom de la routine', { exact: true }).fill('Brouillon confidentiel A');
    await page.getByRole('button', { name: 'Vérifier les prochaines occurrences' }).click();
    await page.evaluate(() => window.__routineFixture.holdNext('save'));
    await page.getByRole('button', { name: 'Enregistrer et activer', exact: true }).click();
    await page.evaluate(() => window.__routineFixture.account('B'));
    await expect(page.getByTestId('fixture-account')).toContainText('Compte B');
    await expect(page.getByRole('heading', { name: 'Bilan privé B', exact: true })).toBeVisible();
    await expect(page.getByLabel('Nom de la routine', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__routineFixture.resolveHeld());
    await expect(page.getByText('Routine enregistrée et activée.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Brouillon confidentiel A', { exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__routineFixture.account(null));
    await expect(page.getByText('Connectez-vous pour retrouver vos routines personnelles.', { exact: true })).toBeVisible();
    await expect(page.getByText('Bilan privé B', { exact: true })).toHaveCount(0);
  });

  await scenario('Loading failure is visible and retry restores the actual list', { failList: true, seeded: true }, async page => {
    await expect(page.getByRole('alert')).toContainText('momentanément indisponible');
    await expect(page.getByRole('button', { name: 'Créer une routine', exact: true })).toHaveCount(0);
    await page.evaluate(() => window.__routineFixture.failList(false));
    await page.getByRole('button', { name: 'Réessayer le chargement', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Bilan privé A', exact: true })).toBeVisible();
  });

  await scenario('Event schedules and voice requests remain truthful', { commands: true }, async page => {
    await page.getByRole('button', { name: 'Besoin d’une décision', exact: true }).click();
    await expect(page.getByLabel('Événement déclencheur', { exact: true })).toHaveValue('decision');
    await page.getByRole('button', { name: 'Vérifier les prochaines occurrences' }).click();
    await expect(page.getByText('Le bilan sera préparé après l’événement choisi, en respectant vos pauses et heures calmes.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer et activer', exact: true }).click();
    await expect(page.getByText('Les demandes en attente ne sont pas exécutées automatiquement.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Exécuter/ })).toHaveCount(0);
  });

  await scenario('One-time schedules interpret local input in the selected timezone', {}, async page => {
    await page.getByRole('button', { name: 'Créer une routine', exact: true }).click();
    await page.getByLabel('Quand ?', { exact: true }).selectOption('once');
    await page.getByLabel('Fuseau horaire', { exact: true }).fill('Europe/Paris');
    await page.getByLabel('Date et heure dans le fuseau choisi', { exact: true }).fill('2026-12-01T08:30');
    await page.getByRole('button', { name: 'Vérifier les prochaines occurrences' }).click();
    const requests = await page.evaluate(() => window.__routineFixture.snapshot().requests.filter(row => row.action === 'preview'));
    assert.equal(requests.at(-1).body.config.schedule.at, '2026-12-01T07:30:00.000Z');
  });

  assert.equal(result.pageErrors.length, 0, 'No JavaScript errors');
  assert.equal(result.externalRequests.length, 0, 'No external request or provider effect');
  result.status = result.tests.every(test => test.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
  result.status = 'BLOCKED'; result.error = error.message; console.error(error);
} finally {
  result.finishedAt = new Date().toISOString();
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await checkpoint();
  if (result.status !== 'PASS') process.exitCode = 1;
}
