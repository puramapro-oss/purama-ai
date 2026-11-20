import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Render the production page, request transport, React Query and UI components.
// Only auth, toast observation, environment and HTTP are inert test boundaries.
const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'https://entraide.invalid/dashboard/entraide', pretendToBeVisual: true,
});
const originalGlobals = new Map();
dom.window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
class ResizeObserverFixture { observe() {} unobserve() {} disconnect() {} }
const replacements = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  SVGElement: dom.window.SVGElement, DocumentFragment: dom.window.DocumentFragment,
  MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
  Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: ResizeObserverFixture, IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(replacements)) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
originalGlobals.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'));
const React = require('react');
const { act, createContext, createElement, useContext } = React;
const { createRoot } = require('react-dom/client');
const { QueryClient, QueryClientProvider, onlineManager } = require('@tanstack/react-query');
const AuthContext = createContext({ user: null, session: null, loading: false });
const loaded = new Map();
let notices = [], requests = [], pendingWrites = [], root, client, serverProfiles, serverMatches, serverMissions, lateReads = [];
const A = 'entraide-user-a', B = 'entraide-user-b';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const profile = (label) => ({ skills_offered: [label], skills_needed: [], availability_days: [], radius_km: null });
const environment = { VITE_SUPABASE_URL: 'https://entraide.example.invalid', VITE_SUPABASE_ANON_KEY: 'inert-public-key' };

function loadSource(filename) {
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const module = { exports: {} }; loaded.set(filename, module);
  const sourceFile = filename.endsWith('/src/pages/Entraide.tsx') && process.env.ENTRAIDE_TEST_PAGE_SOURCE
    ? process.env.ENTRAIDE_TEST_PAGE_SOURCE : filename;
  const source = readFileSync(sourceFile, 'utf8').replaceAll('import.meta.env', JSON.stringify(environment));
  const { outputText } = ts.transpileModule(source, {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const imported = (name) => {
    if (name === '@/hooks/useAuth') return { useAuth: () => useContext(AuthContext) };
    if (name === 'sonner') return { toast: { success: (message) => notices.push(message), error: (message) => notices.push(message) } };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const base = name.startsWith('@/') ? path.join(repo, 'src', name.slice(2)) : path.resolve(path.dirname(filename), name);
      const resolved = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find((p) => existsSync(p) && /\.[cm]?[jt]sx?$/.test(p));
      assert.ok(resolved, 'Unresolved production import: ' + name);
      return loadSource(resolved);
    }
    return require(name);
  };
  runInThisContext('(function(require, module, exports) {\n' + outputText + '\n})', { filename })(imported, module, module.exports);
  return module.exports;
}
const Page = loadSource(path.join(repo, 'src/pages/Entraide.tsx')).default;
let profileReadCount = {}, holdLateAReads = false;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://entraide.example.invalid', 'No external request is permitted');
  const token = options.headers.Authorization;
  const actor = token === 'Bearer token-' + A ? A : token === 'Bearer token-' + B ? B : null;
  assert.ok(actor, 'Request must carry the explicitly current fixture identity');
  const route = url.pathname.replace('/functions/v1/', '');
  const method = options.method || 'GET';
  requests.push({ route, method, actor, signal: options.signal, body: options.body ? JSON.parse(options.body) : undefined });
  if ((method === 'PUT' && route === 'entraide-profil') || (method === 'POST' && (route === 'entraide-contact' || route.startsWith('entraide-missions')))) {
    return new Promise((resolve) => pendingWrites.push({ actor, route, body: JSON.parse(options.body), resolve }));
  }
  assert.equal(method, 'GET', 'Unexpected write in the account-scope fixture');
  if (route === 'entraide-profil') {
    profileReadCount[actor] = (profileReadCount[actor] || 0) + 1;
    if (holdLateAReads && actor === A && profileReadCount[A] > 2) {
      return new Promise((resolve) => lateReads.push(() => resolve(json({ profil: serverProfiles[A] }))));
    }
    return json({ profil: serverProfiles[actor] });
  }
  if (route === 'entraide-matches') return json({ matches: serverMatches[actor] });
  if (route === 'entraide-contact') return json({ requests: [], blocked_user_ids: [] });
  if (route === 'entraide-missions') return json({ missions: serverMissions[actor] });
  throw new Error('Unexpected HTTP boundary: ' + route);
};

async function render(actor) {
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    createElement(AuthContext.Provider, { value: { user: actor ? { id: actor } : null, session: actor ? { access_token: 'token-' + actor } : null, loading: false } },
      createElement(Page)))));
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function until(check, message) {
  const end = Date.now() + 1000;
  while (!check() && Date.now() < end) await settle();
  assert.ok(check(), message);
}
const offered = () => document.getElementById('entraide-offered');
async function visibleProfile(label) { await until(() => offered()?.value === label, 'Expected current profile ' + label); }
async function submit(label) {
  await act(async () => {
    const input = offered(); assert.ok(input);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, label);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Enregistrer mon profil');
    assert.ok(button); button.click();
  });
  await until(() => pendingWrites.length === 1, 'One profile write must reach the inert boundary');
}
async function releaseWrite(status = 200, payload) {
  assert.equal(pendingWrites.length, 1);
  const write = pendingWrites.shift();
  await act(async () => write.resolve(json(payload ?? (status === 200 ? { ok: true } : { error: 'service_unavailable' }), status)));
  await settle();
}
beforeEach(() => {
  onlineManager.setOnline(true);
  notices = []; requests = []; pendingWrites = []; lateReads = []; profileReadCount = {}; holdLateAReads = false;
  serverProfiles = { [A]: profile('A initial'), [B]: profile('B initial') };
  serverMatches = { [A]: [], [B]: [] }; serverMissions = { [A]: [], [B]: [] };
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
});
afterEach(async () => {
  await act(async () => { root.unmount(); for (const write of pendingWrites) write.resolve(json({ ok: true })); for (const release of lateReads) release(); });
  client.clear();
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test('current account can still confirm its real profile mutation', { timeout: 3000 }, async () => {
  await render(A); await visibleProfile('A initial');
  await submit('A saved'); serverProfiles[A] = profile('A saved');
  await releaseWrite(); await visibleProfile('A saved');
  assert.deepEqual(notices, ['Profil d’entraide enregistré.']);
  assert.deepEqual(client.getQueryData(['entraide-profil', A]).profil.skills_offered, ['A saved']);
});

test('old profile response cannot toast or write cache after changing to B', { timeout: 3000 }, async () => {
  await render(A); await visibleProfile('A initial');
  await submit('A obsolete');
  await render(B); await visibleProfile('B initial');
  await releaseWrite();
  assert.deepEqual(notices, [], 'A late success must not announce itself in B');
  assert.equal(offered().value, 'B initial');
  assert.deepEqual(client.getQueryData(['entraide-profil', A]).profil.skills_offered, ['A initial']);
});

test('old profile response cannot announce success after logout', { timeout: 3000 }, async () => {
  await render(A); await visibleProfile('A initial'); await submit('A obsolete');
  await render(null); await releaseWrite();
  assert.match(document.body.textContent, /Connecte-toi/);
  assert.deepEqual(notices, [], 'No old success notice may cross logout');
  assert.deepEqual(client.getQueryData(['entraide-profil', A]).profil.skills_offered, ['A initial']);
});

test('A-B-A cannot let the first lifetime replace the freshly read A profile', { timeout: 3000 }, async () => {
  await render(A); await visibleProfile('A initial'); await submit('A obsolete');
  await render(B); await visibleProfile('B initial');
  serverProfiles[A] = profile('A current'); holdLateAReads = true;
  await render(A); await visibleProfile('A current');
  await releaseWrite();
  assert.deepEqual({
    notices, displayed: offered().value,
    cached: client.getQueryData(['entraide-profil', A]).profil.skills_offered, reads: profileReadCount[A],
  }, { notices: [], displayed: 'A current', cached: ['A current'], reads: 2 }, 'The first A lifetime must not overwrite, notify or refetch in the new A lifetime');
});

test('a current server refusal remains visible and does not confirm a save', { timeout: 3000 }, async () => {
  await render(A); await visibleProfile('A initial'); await submit('A refused');
  await releaseWrite(503);
  await until(() => document.body.textContent.includes('momentanément indisponible'), 'Current refusal must remain observable');
  assert.deepEqual(notices, []);
  assert.equal(offered().value, 'A refused', 'The editable draft must survive a current refusal');
});

async function clickButton(label) {
  await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent === label), 'Expected button ' + label);
  await act(async () => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
    button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    button.click();
  });
}
async function fillInput(id, value) {
  await act(async () => {
    const input = document.getElementById(id); assert.ok(input);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
const mission = (extra = {}) => ({
  id: 'scope-mission', title: 'Scoped mission', description: '', organizer_id: A, revision: 7,
  status: 'ouverte', visibility: 'private', min_participants: 2, max_participants: 10,
  missions_collectives_participants: [{ user_id: A, joined_at: '2026-11-11T00:00:00Z' }], ...extra,
});
async function publishMission() {
  await render(A); await visibleProfile('A initial'); await clickButton('Missions');
  await clickButton('Rendre visible au réseau');
  await until(() => pendingWrites.length === 1, 'Publish command must reach the boundary');
}

test('late contact confirmation cannot notify or populate an expired account cache', { timeout: 3000 }, async () => {
  serverMatches[A] = [{ userId: 'contact-recipient', score: 70, reasons: ['Compétences communes'] }];
  await render(A); await visibleProfile('A initial'); await clickButton('Demander un contact');
  await until(() => pendingWrites.length === 1, 'Contact intent must reach the boundary');
  const command = pendingWrites[0].body;
  assert.equal(command.recipient_id, 'contact-recipient'); assert.ok(command.id);
  await render(B); await visibleProfile('B initial');
  await releaseWrite(200, { request: { id: command.id, requester_id: A, recipient_id: command.recipient_id, status: 'pending', created_at: '2026-11-11T00:00:00Z' } });
  assert.deepEqual(notices, []);
  assert.deepEqual(client.getQueryData(['entraide-contacts', A]).requests, []);
});

test('late mission creation cannot notify or populate an expired account cache', { timeout: 3000 }, async () => {
  await render(A); await visibleProfile('A initial'); await clickButton('Missions');
  await until(() => document.getElementById('entraide-mission-title'), 'Mission form is rendered');
  await fillInput('entraide-mission-title', 'Private intent');
  await clickButton('Créer ma mission privée');
  await until(() => pendingWrites.length === 1, 'Creation must reach the boundary');
  const command = pendingWrites[0].body;
  assert.equal(command.id, command.request_id); assert.equal(command.visibility, 'private');
  await render(B); await visibleProfile('B initial');
  await releaseWrite(200, { mission: mission({ id: command.id, title: command.title, revision: 0 }) });
  assert.deepEqual(notices, []);
  assert.deepEqual(client.getQueryData(['entraide-missions', A]).missions, []);
});

test('late mission action cannot publish a success or overwrite the cached revision after account change', { timeout: 3000 }, async () => {
  serverMissions[A] = [mission()]; await publishMission();
  assert.equal(pendingWrites[0].body.expected_revision, 7);
  assert.ok(pendingWrites[0].body.request_id);
  await render(B); await visibleProfile('B initial');
  await releaseWrite(200, { mission: mission({ visibility: 'public', revision: 8 }) });
  assert.deepEqual(notices, []);
  assert.equal(client.getQueryData(['entraide-missions', A]).missions[0].revision, 7);
});

test('current mission retry preserves the exact intent and expected revision', { timeout: 3000 }, async () => {
  serverMissions[A] = [mission()]; await publishMission();
  const original = { ...pendingWrites[0].body };
  await releaseWrite(503);
  await clickButton('Réessayer');
  await until(() => pendingWrites.length === 1, 'Explicit retry must reach the boundary');
  assert.deepEqual(pendingWrites[0].body, original);
  assert.equal(original.expected_revision, 7);
  serverMissions[A] = [mission({ visibility: 'public', revision: 8 })];
  await releaseWrite(200, { mission: serverMissions[A][0] });
  assert.deepEqual(notices, ['La mission est visible dans le réseau.']);
  assert.equal(client.getQueryData(['entraide-missions', A]).missions[0].revision, 8);
});
