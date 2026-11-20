import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test as base } from '@playwright/test';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);

const test = base.extend<{ configured: boolean; appOrigin: string; loopbackOnly: void }>({
  configured: [false, { option: true }],
  appOrigin: async ({ configured }, provide) => {
    const outDir = await mkdtemp(join(tmpdir(), 'iao-startup-'));
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    try {
      await exec(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', outDir], {
        cwd: root,
        env: {
          ...process.env,
          VITE_SUPABASE_URL: configured ? 'http://127.0.0.1:54321' : '',
          VITE_SUPABASE_PUBLISHABLE_KEY: configured ? 'local-browser-test-key' : '',
        },
      });
      server = await preview({ root, configFile: false, build: { outDir }, logLevel: 'error',
        preview: { host: '127.0.0.1', port: 0, strictPort: true } });
      const address = server.httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Loopback preview did not start');
      await provide(`http://127.0.0.1:${address.port}`);
    } finally {
      await server?.close();
      await rm(outDir, { recursive: true, force: true });
    }
  },
  loopbackOnly: [async ({ appOrigin, context }, provide, testInfo) => {
    const blocked = new Set<string>();
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === appOrigin && ['GET', 'HEAD'].includes(request.method())) return route.continue();
      blocked.add(url.origin);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      blocked.add(new URL(socket.url()).origin);
      socket.close();
    });
    await provide();
    await testInfo.attach('startup-network.json', {
      body: Buffer.from(JSON.stringify({ loopbackOrigin: appOrigin, blockedOrigins: [...blocked] })),
      contentType: 'application/json',
    });
  }, { auto: true }],
});

test.use({ locale: 'fr-FR', serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

test('starts the local workspace from the recovery screen when configuration is missing', async ({ page, appOrigin }) => {
  const uncaught: string[] = [];
  page.on('pageerror', error => uncaught.push(error.message));
  expect((await page.goto(appOrigin))?.status()).toBe(200);
  const heading = page.getByRole('heading', { name: 'Une erreur est survenue' });
  await expect(heading).toBeVisible();
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Recharger la page' }).click()]);
  await expect(heading).toBeVisible();
  const local = page.getByRole('link', { name: 'Ouvrir l’espace local' });
  await expect(local).toHaveAttribute('href', '/offline.html');
  await local.click();
  await expect(page).toHaveURL(new URL('/offline.html', appOrigin).href);
  await expect(page.locator('#storage-status')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#backup-library')).toBeEnabled();
  expect(uncaught).toEqual([]);
});

test.describe('with a loopback Supabase configuration', () => {
  test.use({ configured: true });
  test('opens the login screen for a protected URL without a user session', async ({ page, appOrigin }) => {
    const uncaught: string[] = [];
    page.on('pageerror', error => uncaught.push(error.message));
    expect((await page.goto(new URL('/dashboard', appOrigin).href))?.status()).toBe(200);
    await expect(page).toHaveURL(new URL('/login', appOrigin).href);
    await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
    await expect(page.locator('form input[type="email"]')).toBeEditable();
    await expect(page.locator('form input[type="password"]')).toBeEditable();
    await expect(page.getByRole('heading', { name: 'Une erreur est survenue' })).toHaveCount(0);
    expect(uncaught).toEqual([]);
  });
});
