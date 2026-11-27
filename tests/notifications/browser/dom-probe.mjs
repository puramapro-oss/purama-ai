import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const artifact = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { JSDOM, VirtualConsole } = require('jsdom');
const manifest = JSON.parse(await readFile(path.join(artifact, 'manifest.json'), 'utf8'));
const bundle = await readFile(path.join(artifact, 'bundle.js'), 'utf8');
assert.equal(createHash('sha256').update(bundle).digest('hex'), manifest.files['bundle.js']);
const observations = [];
const waitFor = async predicate => {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('DOM state did not settle within five seconds');
};

for (const view of ['settings', 'notifications', 'center']) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: `http://127.0.0.1/?view=${view}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  Object.assign(dom.window, { TextEncoder, TextDecoder, structuredClone,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
  dom.window.__notificationScenario = {
    rows: { A: [{ id: 'recovered', user_id: 'A', type: 'alert', title: 'RECOVERED_NOTIFICATION', message: 'Synthetic',
      agent_slug: null, read: false, action_url: null, created_at: '2026-11-27T00:00:00Z' }] },
    preferences: { A: { id: 'p-A', user_id: 'A', email_enabled: false, task_completed_enabled: false,
      question_enabled: true, daily_report_enabled: false, alert_enabled: true } },
    rules: [{ table: view === 'settings' ? 'notification_preferences' : 'notifications', action: 'select', mode: 'error' }],
  };
  dom.window.eval(bundle);
  const document = dom.window.document;
  try {
    await waitFor(() => document.querySelector('[data-sonner-toast]'));
    if (view === 'center') {
      document.querySelector('[data-testid="product-surface"] button').click();
      await waitFor(() => document.querySelector('[role="alert"]'));
    }
    const before = {
      body: document.body.textContent,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      switches: [...document.querySelectorAll('[role="switch"]')].map(node => ({ id: node.id, checked: node.getAttribute('aria-checked'), disabled: node.disabled })),
    };
    assert.ok(before.alerts.length >= 1, `${view}: loading failure must be explicit`);
    assert.equal(before.switches.length, 0, `${view}: unavailable preferences must not appear as checked defaults`);
    assert.ok(!before.body.includes('Aucune notification'), `${view}: an error is not an empty list`);
    assert.ok(!before.body.includes('Toutes les notifications sont lues'), `${view}: an error is not a read receipt`);
    const retry = [...document.querySelectorAll('button')].find(node => node.textContent === 'Réessayer');
    assert.ok(retry && !retry.disabled, `${view}: retry must be offered`);
    retry.click();
    await waitFor(() => view === 'settings' ? document.querySelector('#email-enabled')?.getAttribute('aria-checked') === 'false' : document.body.textContent.includes('RECOVERED_NOTIFICATION'));
    const after = {
      body: document.body.textContent,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
      switches: [...document.querySelectorAll('[role="switch"]')].map(node => ({ id: node.id, checked: node.getAttribute('aria-checked'), disabled: node.disabled })),
    };
    assert.equal(after.alerts.length, 0, `${view}: successful retry clears the load error`);
    assert.deepEqual(errors, []);
    observations.push({ view, status: 'PASS', before, after, errors });
  } catch (error) {
    observations.push({ view, status: 'FAIL', message: error.message, body: document.body.textContent, errors });
  } finally { dom.window.__notificationQueryClient?.clear(); dom.window.close(); }
}

const report = { status: observations.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL',
  mode: 'REAL_REACT_DOM_IN_JSDOM_NOT_BROWSER', at: new Date().toISOString(), node: process.version,
  jsdom: require('jsdom/package.json').version, sourceSha256: manifest.sourceSha256,
  bundleSha256: manifest.files['bundle.js'], observations,
  limits: ['No browser engine, screenshot or visual layout verified', 'Auth/DB/Realtime transport fixtures; no production request or email'] };
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, observations: observations.map(({ view, status, message }) => ({ view, status, message })) }));
if (report.status !== 'PASS') process.exitCode = 1;
