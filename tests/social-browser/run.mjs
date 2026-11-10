// Run directly with Node; no real account, publication, or network provider.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react-swc';
const { firefox } = await import(process.env.SOCIAL_PLAYWRIGHT_MODULE || 'playwright');

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
  browser = await firefox.launch({ headless: true, timeout: 30000 });
  console.log('Browser launched');
  async function scenario(label, run) {
    console.log('Checking ' + label);
    const context = await browser.newContext();
    console.log('Context ready');
    context.setDefaultTimeout(15000);
    const errors = [];
    await context.route('**/*', route => route.request().url().startsWith(origin + '/')
      ? route.continue() : route.abort());
    const page = await context.newPage();
    console.log('Page ready');
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.goto(origin);
      await page.locator('[data-testid="publish-control"] button').waitFor();
      await run(page);
      assert.deepEqual(errors, []);
      console.log('PASS ' + label); passed++;
    } finally { await context.close(); }
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
  const calls = page => page.evaluate(() => window.__socialFixture.calls.filter(call => call.name === 'social-publish'));
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
  console.log(`RESULT ${passed} browser scenarios passed; no external network allowed.`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
