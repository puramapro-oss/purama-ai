import { createServer } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const evidence = path.resolve(process.env.FOUNDER_DASHBOARD_EVIDENCE || path.join(root, 'docs/founder-dashboard/evidence'));
const results = [];
const externalRequests = new Set();
const errors = [];
let server, browser, origin;
const startedAt = new Date().toISOString();

async function check(name, fn, viewport = { width: 1280, height: 1000 }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && ['GET', 'HEAD'].includes(route.request().method())) return route.continue();
    externalRequests.add(url.origin);
    return route.abort('blockedbyclient');
  });
  await context.routeWebSocket('**/*', route => {
    const url = new URL(route.url());
    if (url.origin !== origin.replace('http:', 'ws:')) externalRequests.add(url.origin);
    route.close();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await fn(page);
    expect(pageErrors, 'browser exceptions').toEqual([]);
    results.push({ name, status: 'PASS' });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, status: 'FAIL', message: error.message });
    errors.push(...pageErrors);
    console.error('FAIL ' + name + ': ' + error.message);
    await page.screenshot({ path: path.join(evidence, 'browser-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

const url = (query='') => origin + '/tests/founder-dashboard/browser/index.html' + query;
const ready = async (page) => expect(page.getByTestId('profiles')).toHaveText('42');

try {
  // A fresh temporary profile; CI uses installed Playwright Chromium.
  // Local operators can select an existing browser with the same option as test:quality.
  browser = await chromium.launch({
    headless: true, args: ['--no-zygote', '--disable-gpu', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
  console.log('CHROME ' + browser.version());
  server = await createServer({
    configFile: false, root, envDir: here, cacheDir: path.join(here, '.vite'),
    clearScreen: false, logLevel: 'warn',
    plugins: [react()],
    optimizeDeps: { entries: [path.join(here, 'index.html')] },
    resolve: { alias: [
      { find: '@/hooks/useAuth', replacement: path.join(here, 'auth-mock.jsx') },
      { find: '@/integrations/supabase/client', replacement: path.join(here, 'supabase-mock.js') },
      { find: '@', replacement: path.join(root, 'src') },
    ] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  origin = 'http://127.0.0.1:' + address.port;
  console.log('HARNESS ' + origin + ' (mock services only)');

  await check('compte propriétaire : rendu réel et requête GET', async (page) => {
    await page.goto(url());
    await ready(page);
    await expect(page.getByRole('heading', { name: 'Votre centre de pilotage' })).toBeVisible();
    await expect(page.getByTestId('activeSubscriptions')).toHaveText('0');
    expect(await page.evaluate(() => window.__calls)).toEqual([{name:'founder-dashboard',method:'GET',timeout:10000}]);
  });

  for (const kind of ['anonymous','stranger','unverified']) {
    await check(kind + ' : accès refusé sans requête', async (page) => {
      await page.goto(url('?auth=' + kind));
      await expect(page.getByRole('heading', { name:'Espace privé' })).toBeVisible();
      expect(await page.evaluate(() => window.__calls.length)).toBe(0);
      await expect(page.getByTestId('profiles')).toHaveCount(0);
    });
  }

  await check('authentification en attente : pas de données ni requête', async (page) => {
    await page.goto(url('?auth=loading'));
    await expect(page.getByRole('status')).toHaveText('Vérification du compte…');
    expect(await page.evaluate(() => window.__calls.length)).toBe(0);
  });

  await check('lecture lente : état de chargement et bouton bloqué', async (page) => {
    await page.goto(url('?scenario=hold'));
    await expect(page.getByText('Lecture sécurisée en cours…')).toBeVisible();
    await expect(page.getByRole('button', {name:'Actualiser le tableau de bord'})).toBeDisabled();
    await expect(page.getByTestId('profiles')).toHaveText('—');
    await page.evaluate(() => window.__release());
    await ready(page);
  });

  await check('réponse partielle : zéro confirmé distinct de donnée indisponible', async (page) => {
    await page.goto(url('?scenario=partial'));
    await ready(page);
    await expect(page.getByTestId('activeSubscriptions')).toHaveText('0');
    await expect(page.getByTestId('enabledAgents')).toHaveText('—');
    await expect(page.getByText(/Certaines sources sont indisponibles/)).toBeVisible();
  });

  await check('erreur serveur : message sûr et reprise manuelle', async (page) => {
    await page.goto(url('?scenario=error'));
    await expect(page.getByRole('alert')).toContainText('pas encore disponible');
    await expect(page.getByTestId('profiles')).toHaveText('—');
    expect(await page.locator('body').innerText()).not.toContain('INTERNAL_SECRET');
    await page.evaluate(() => { window.__scenario='success'; });
    await page.getByRole('button', {name:'Actualiser le tableau de bord'}).click();
    await ready(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.__calls.length)).toBe(2);
  });

  await check('actualisation manuelle : ancienne valeur effacée en erreur', async (page) => {
    await page.goto(url()); await ready(page);
    await page.evaluate(() => { window.__scenario='error'; });
    await page.getByRole('button', {name:'Actualiser le tableau de bord'}).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('profiles')).toHaveText('—');
    await expect(page.getByText('Profil de recette', {exact:true})).toHaveCount(0);
  });

  await check('actualisation automatique : minute et arrêt effectif', async (page) => {
    await page.clock.install();
    await page.goto(url()); await ready(page);
    await page.clock.runFor(60010);
    await expect.poll(() => page.evaluate(() => window.__calls.length)).toBe(2);
    const toggle=page.getByRole('button', {name:/Actualisation automatique/});
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed','false');
    await page.clock.runFor(120010);
    expect(await page.evaluate(() => window.__calls.length)).toBe(2);
  });

  await check('changement de compte pendant une requête : résultat ancien écarté', async (page) => {
    await page.goto(url('?scenario=hold'));
    await expect(page.getByText('Lecture sécurisée en cours…')).toBeVisible();
    await page.evaluate(() => { window.__setAuth('stranger'); });
    await expect(page.getByRole('heading',{name:'Espace privé'})).toBeVisible();
    await page.evaluate(() => window.__release());
    await expect(page.getByTestId('profiles')).toHaveCount(0);
    await expect(page.getByText('PRIVATE_PREVIOUS_OWNER',{exact:true})).toHaveCount(0);
    expect(await page.evaluate(() => window.__calls.length)).toBe(1);
  });

  await check('déconnexion après succès : informations retirées immédiatement', async (page) => {
    await page.goto(url()); await ready(page);
    await page.evaluate(() => window.__setAuth('anonymous'));
    await expect(page.getByRole('heading',{name:'Espace privé'})).toBeVisible();
    await expect(page.getByTestId('profiles')).toHaveCount(0);
    await expect(page.getByText('Profil de recette',{exact:true})).toHaveCount(0);
  });

  await check('nom du profil échappé, aucune exécution HTML', async (page) => {
    await page.goto(url('?scenario=xss')); await ready(page);
    await expect(page.getByText('<img src=x onerror="window.__injected=true">',{exact:true})).toBeVisible();
    expect(await page.evaluate(() => Boolean(window.__injected))).toBe(false);
    await expect(page.locator('img')).toHaveCount(0);
  });

  await check('navigation : employés IA et comptabilité existants', async (page) => {
    await page.goto(url()); await ready(page);
    await expect(page.getByRole('link',{name:'Voir mes employés IA'})).toHaveAttribute('href','/dashboard/employees');
    await page.getByRole('link',{name:'Voir mes employés IA'}).click();
    await expect(page).toHaveURL(origin + '/dashboard/employees');
    await page.goto(url()); await ready(page);
    await expect(page.getByRole('link',{name:'Ouvrir mon espace comptable'})).toHaveAttribute('href','/dashboard/compta-agent');
    await page.getByRole('link',{name:'Ouvrir mon espace comptable'}).click();
    await expect(page).toHaveURL(origin + '/dashboard/compta-agent');
  });

  for (const width of [390,1280]) {
    await check('mise en page ' + width + ' px : aucun débordement', async (page) => {
      await page.goto(url()); await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await expect(page.getByRole('button',{name:'Actualiser le tableau de bord'})).toBeVisible();
      await page.screenshot({path:path.join(evidence,width===390?'browser-mobile.png':'browser-desktop.png'),fullPage:true});
    }, {width,height:1000});
  }
} catch (error) {
  if (!results.some((entry)=>entry.status==='FAIL')) {
    results.push({name:'browser or harness startup',status:'BLOCKED',message:error.message});
    console.error(error.stack);
  }
  process.exitCode=1;
} finally {
  const chromeVersion=browser?.version() || null;
  await browser?.close();
  await server?.close();
  await fs.mkdir(evidence,{recursive:true});
  const report={startedAt,finishedAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,chrome:chromeVersion,network:'localhost only; external requests blocked',backend:'simulated',actualComponent:'src/pages/AdminDashboard.tsx'},results,externalOriginsBlocked:[...externalRequests],pageErrors:errors};
  await fs.writeFile(path.join(evidence,'browser-results.json'),JSON.stringify(report,null,2)+'\n');
  if (results.length !== 16 || results.some(r => r.status !== 'PASS') || externalRequests.size || errors.length) process.exitCode = 1;
  console.log('SUMMARY '+JSON.stringify({pass:results.filter((r)=>r.status==='PASS').length,fail:results.filter((r)=>r.status!=='PASS').length,exitCode:process.exitCode||0}));
}
