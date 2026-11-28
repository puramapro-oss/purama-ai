import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exécute le vrai transport, avec seulement la configuration Vite et fetch substitués.
// Ce sont des tests unitaires réseau ; ils ne remplacent pas les parcours navigateur/API/SQL.
const source = await readFile(new URL('../../src/lib/entraide-http.ts', import.meta.url), 'utf8');
const environment = { VITE_SUPABASE_URL: 'https://entraide.example.test/', VITE_SUPABASE_ANON_KEY: 'public-test-key' };
let moduleId = 0;
async function transport(env = environment) {
  const compiled = ts.transpileModule(source.replaceAll('import.meta.env', `(${JSON.stringify(env)})`), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${moduleId++}`);
}
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

test('envoie apikey, un unique Bearer, JSON et le signal au bon endpoint', async (t) => {
  const { requestEntraide } = await transport();
  const controller = new AbortController();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return json({ ok: true }); });
  const body = { skills_offered: ['couture'], radius_km: 0 };
  assert.deepEqual(await requestEntraide('entraide-profil', { token: 'Bearer session-test', method: 'PUT', body, signal: controller.signal }), { ok: true });
  assert.equal(calls.length, 1);
  const [url, options] = calls[0];
  assert.equal(url, 'https://entraide.example.test/functions/v1/entraide-profil');
  assert.equal(options.headers.Authorization, 'Bearer session-test');
  assert.equal(options.headers.apikey, 'public-test-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.signal, controller.signal);
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), body);
});

test('GET accepte un jeton brut sans envoyer de corps', async (t) => {
  const { requestEntraide } = await transport();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer session-test');
    assert.equal(options.body, undefined);
    assert.equal(options.headers['Content-Type'], undefined);
    return json({ missions: [] });
  });
  assert.deepEqual(await requestEntraide('entraide-missions', { token: 'session-test' }), { missions: [] });
});

test('utilise la clé publique configurée par le vrai client de l’application, avec repli ANON compatible', async (t) => {
  const keys = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { keys.push(options.headers.apikey); return json({ profil: null }); });
  for (const env of [
    { VITE_SUPABASE_URL: environment.VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key' },
    { ...environment, VITE_SUPABASE_PUBLISHABLE_KEY: ' publishable-test-key ' },
    { ...environment, VITE_SUPABASE_PUBLISHABLE_KEY: ' ' },
  ]) {
    const { requestEntraide } = await transport(env);
    await requestEntraide('entraide-profil', { token: 'session-test' });
  }
  assert.deepEqual(keys, ['publishable-test-key', 'publishable-test-key', 'public-test-key']);
});

test('conserve le corps et son ID pour une seconde tentative après perte de réponse', async (t) => {
  const { requestEntraide } = await transport();
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) throw new TypeError('network details');
    return json({ mission: { id: 'stable-operation-id' } });
  });
  const options = { token: 'session-test', method: 'POST', body: { id: 'stable-operation-id', title: 'Jardin partagé', visibility: 'private' } };
  await assert.rejects(requestEntraide('entraide-missions', options), (error) => error.code === 'network_error');
  await requestEntraide('entraide-missions', options);
  assert.equal(bodies[0], bodies[1]);
});

test('refuse les URL externes et traversées avant tout envoi de jeton', async (t) => {
  const { requestEntraide } = await transport();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  for (const route of ['https://other.example.test/entraide-profil', '//other.example.test', 'entraide-missions/../secrets', 'entraide-contact?redirect=elsewhere', 'other-service']) {
    await assert.rejects(requestEntraide(route, { token: 'session-test' }), (error) => error.code === 'invalid_route');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('refuse la session vide et la configuration incomplète avant le réseau', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  const normal = await transport();
  await assert.rejects(normal.requestEntraide('entraide-profil', { token: '' }), (error) => error.status === 401);
  const missing = await transport({ VITE_SUPABASE_URL: environment.VITE_SUPABASE_URL });
  await assert.rejects(missing.requestEntraide('entraide-profil', { token: 'session-test' }), (error) => error.code === 'missing_configuration');
  assert.equal(fetch.mock.callCount(), 0);
});

test('refuse les configurations HTTP distantes et les identifiants dans une URL', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  for (const VITE_SUPABASE_URL of ['http://remote.example.test', 'https://user:secret@example.test', 'https://example.test/?secret=token']) {
    const { requestEntraide } = await transport({ ...environment, VITE_SUPABASE_URL });
    await assert.rejects(requestEntraide('entraide-profil', { token: 'session-test' }), (error) => error.code === 'invalid_configuration');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('autorise Supabase local HTTP pour la validation en développement', async (t) => {
  const { requestEntraide } = await transport({ ...environment, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' });
  t.mock.method(globalThis, 'fetch', async (url) => { assert.equal(url, 'http://127.0.0.1:54321/functions/v1/entraide-profil'); return json({ profil: null }); });
  assert.deepEqual(await requestEntraide('entraide-profil', { token: 'session-test' }), { profil: null });
});

test('affiche un conflit de révision français sans divulguer les détails du serveur', async (t) => {
  const { requestEntraide, EntraideHttpError } = await transport();
  t.mock.method(globalThis, 'fetch', async () => json({ error: 'revision_conflict', details: 'password=secret stack internal.sql' }, 409));
  await assert.rejects(requestEntraide('entraide-missions/id/start', { token: 'session-test', method: 'POST', body: { expected_revision: 3 } }), (error) => {
    assert.ok(error instanceof EntraideHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'revision_conflict');
    assert.match(error.message, /mission a changé/);
    assert.doesNotMatch(error.message, /secret|password|internal/);
    return true;
  });
});

test('masque les erreurs brutes JSON et HTML inconnues', async (t) => {
  const { requestEntraide } = await transport();
  let counter = 0;
  t.mock.method(globalThis, 'fetch', async () => counter++ === 0 ? json({ error: 'db password=secret stack:fn.sql' }, 400) : new Response('<html>password=secret</html>', { status: 502 }));
  for (let i = 0; i < 2; i++) {
    await assert.rejects(requestEntraide('entraide-profil', { token: 'session-test' }), (error) => {
      assert.doesNotMatch(error.message, /secret|password|stack|html|fn.sql/);
      return true;
    });
  }
});

test('conserve Retry-After et explique la limite de contact', async (t) => {
  const { requestEntraide } = await transport();
  t.mock.method(globalThis, 'fetch', async () => json({ error: 'cooldown_active' }, 429, { 'Retry-After': '45' }));
  await assert.rejects(requestEntraide('entraide-contact', { token: 'session-test', method: 'POST', body: {} }), (error) => error.status === 429 && error.retryAfterSeconds === 45 && /45 s/.test(error.message) && /demande récente/.test(error.message));
});

test('ne confirme pas un succès HTTP au corps invalide ou contenant une erreur', async (t) => {
  const { requestEntraide } = await transport();
  const payloads = [null, [], 'ok', { ok: false }, { error: 'service_unavailable' }];
  t.mock.method(globalThis, 'fetch', async () => json(payloads.shift()));
  for (let i = 0; i < 5; i++) {
    await assert.rejects(requestEntraide('entraide-profil', { token: 'session-test' }), (error) => error.code === 'invalid_response');
  }
});

test('préserve l’annulation pendant la requête et pendant la lecture de sa réponse', async (t) => {
  const { requestEntraide } = await transport();
  const controller = new AbortController();
  const abort = new DOMException('Aborted', 'AbortError');
  let counter = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    if (counter++ === 0) throw abort;
    return { ok: true, json: async () => { controller.abort(); throw abort; } };
  });
  await assert.rejects(requestEntraide('entraide-profil', { token: 'session-test' }), (error) => error === abort);
  await assert.rejects(requestEntraide('entraide-profil', { token: 'session-test', signal: controller.signal }), (error) => error === abort);
});
