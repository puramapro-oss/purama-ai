import { before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

// Production settings functions + the frontend's real Supabase/PostgREST SDK
// execute against a deterministic in-memory HTTP adapter. Literal defaults
// come from the migration, including its legacy auto_play=true default.
// This verifies the SDK/HTTP contract: PostgreSQL, a hosted PostgREST server,
// authentication and RLS are NOT executed or qualified by these tests.
// Same-field writes retain ordinary arrival ordering; no intent-order or
// cross-device monotonic-revocation guarantee is claimed by these tests.
const repo = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const sdkVersion = require('@supabase/supabase-js/package.json').version;
const rootLock = JSON.parse(readFileSync(`${repo}package-lock.json`, 'utf8'));
assert.equal(sdkVersion, rootLock.packages['node_modules/@supabase/supabase-js'].version,
  'The regression must run the frontend SDK version recorded in the root lockfile');

// Only this test loader accepts an isolated historical source for a baseline.
// The default always loads the real production module without replacing it.
const sourcePath = process.env.VOICE_SETTINGS_TEST_SOURCE ?? `${repo}src/lib/voice.ts`;
assert.ok(isAbsolute(sourcePath), 'VOICE_SETTINGS_TEST_SOURCE must be an absolute path');
console.log(`Voice settings: frontend SDK @supabase/supabase-js@${sdkVersion}; TypeScript@${ts.version}`);
console.log(`Voice settings source: ${sourcePath}`);

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const columns = new Set(['user_id', 'provider', 'voice_id', 'speed', 'auto_play',
  'enabled', 'language', 'created_at', 'updated_at']);
const tableRows = new Map();
let sqlDefaults;
let compiledVoice;
let clientSequence = 0;

before(() => {
  const migration = readFileSync(`${repo}supabase/migrations/20260407100000_voice_chat.sql`, 'utf8');
  const table = migration.match(/CREATE TABLE IF NOT EXISTS purama_ai\.voice_settings \([\s\S]*?\n\);/)?.[0];
  assert.ok(table, 'The versioned voice_settings table must exist');
  sqlDefaults = {};
  for (const column of ['provider', 'voice_id', 'speed', 'auto_play', 'enabled', 'language']) {
    const literal = table.match(new RegExp(
      `^\\s*${column}\\s+[^\\n]*?\\bDEFAULT\\s+('[^']*'|true|false|\\d+(?:\\.\\d+)?)(?=\\s|,|$)`, 'm'))?.[1];
    assert.ok(literal, `Missing literal SQL default for ${column}`);
    sqlDefaults[column] = literal.startsWith("'") ? literal.slice(1, -1)
      : literal === 'true' ? true : literal === 'false' ? false : Number(literal);
  }
  // Only Vite environment expressions in the unused TTS function are replaced
  // so this production module can use the existing CommonJS VM test pattern.
  // The settings functions are neither rewritten nor copied into this test.
  const source = readFileSync(sourcePath, 'utf8').replaceAll('import.meta.env', '({})');
  compiledVoice = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
});

beforeEach(() => { tableRows.clear(); });

function assertFields(actual, expected) {
  assert.ok(actual, 'Expected a settings row');
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(actual[key], value, `Unexpected settings field: ${key}`);
}

function assertPartialWrite(request, patch) {
  assert.equal(request?.method, 'PATCH');
  assert.equal(request.url.searchParams.get('user_id'), `eq.${owner}`);
  assert.equal(typeof request.body.updated_at, 'string');
  assert.deepEqual(request.body, { ...patch, user_id: owner, updated_at: request.body.updated_at });
}

function latch() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function checkColumns(row) {
  const names = Object.keys(row);
  if (!names.length || names.some(name => !columns.has(name))) throw new Error('Unsupported fixture column');
}

function seed(userId, values = {}) {
  checkColumns({ ...values, user_id: userId });
  tableRows.set(userId, { ...sqlDefaults, created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z', ...values, user_id: userId });
}

function stored(userId) {
  const row = tableRows.get(userId);
  return row ? { ...row, speed: Number(row.speed) } : undefined;
}

function fixture() {
  const requests = [];
  const holds = [];
  const failures = [];

  const transport = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://voice-fixture.invalid' || url.pathname !== '/rest/v1/voice_settings')
      throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`);
    const wire = { method: request.method, url, headers: request.headers,
      body: request.method === 'GET' ? {} : JSON.parse(await request.text()) };
    requests.push(wire);
    const failure = failures.find(item => !item.used && item.match(wire));
    if (failure) {
      failure.used = true;
      return Response.json({ code: 'TEST_UNAVAILABLE', message: 'Voice storage unavailable', details: null, hint: null }, { status: 503 });
    }
    const hold = holds.find(item => !item.used && item.phase === 'before' && item.match(wire));
    if (hold) { hold.used = true; hold.reached.resolve(); await hold.release.promise; }

    let rows;
    try {
      if (wire.method === 'GET' || wire.method === 'PATCH') {
        const filter = url.searchParams.get('user_id');
        if (!filter?.startsWith('eq.')) throw new Error('A user_id equality filter is required');
        const userId = filter.slice(3);
        const current = tableRows.get(userId);
        if (wire.method === 'GET') {
          rows = current ? [{ ...current }] : [];
        } else {
          checkColumns(wire.body);
          const next = current ? { ...current, ...wire.body } : undefined;
          rows = [];
          if (next) {
            const targetId = String(next.user_id);
            if (targetId !== userId && tableRows.has(targetId))
              throw { code: '23505', message: 'Duplicate user_id' };
            tableRows.delete(userId);
            tableRows.set(targetId, next);
            rows = [{ ...next }];
          }
        }
      } else if (wire.method === 'POST') {
        checkColumns(wire.body);
        const prefer = request.headers.get('prefer') ?? '';
        const ignore = prefer.includes('resolution=ignore-duplicates');
        const merge = prefer.includes('resolution=merge-duplicates');
        if ((ignore || merge) && url.searchParams.get('on_conflict') !== 'user_id')
          throw new Error('Unsupported fixture conflict target');
        if (typeof wire.body.user_id !== 'string') throw new Error('A user_id is required');
        const userId = wire.body.user_id;
        const current = tableRows.get(userId);
        if (current && ignore) rows = [];
        else {
          if (current && !merge) throw { code: '23505', message: 'Duplicate user_id' };
          const next = { ...sqlDefaults, created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z', ...current, ...wire.body };
          tableRows.set(userId, next);
          rows = [{ ...next }];
        }
      } else throw new Error(`Unsupported fixture method: ${wire.method}`);
    } catch (error) {
      return Response.json({ code: error.code ?? 'TEST_CONTRACT_ERROR', message: error.message ?? 'Fixture error',
        details: null, hint: null }, { status: error.code === '23505' ? 409 : 400 });
    }
    const afterWrite = holds.find(item => !item.used && item.phase === 'after' && item.match(wire));
    if (afterWrite) { afterWrite.used = true; afterWrite.reached.resolve(); await afterWrite.release.promise; }

    // Match the PostgREST representation/minimal and singular-object contracts
    // used by the actual SDK rather than replacing its query builder methods.
    if (wire.method !== 'GET' && !request.headers.get('prefer')?.includes('return=representation'))
      return new Response(null, { status: 204 });
    if (request.headers.get('accept')?.includes('application/vnd.pgrst.object+json')) {
      if (rows.length !== 1) return Response.json({ code: 'PGRST116', message: 'Cannot coerce the result to a single JSON object',
        details: `The result contains ${rows.length} rows`, hint: null }, { status: 406 });
      return Response.json(rows[0], { status: wire.method === 'POST' ? 201 : 200 });
    }
    return Response.json(rows, { status: wire.method === 'POST' ? 201 : 200 });
  };

  function load() {
    const client = createClient('https://voice-fixture.invalid', 'test-only-not-a-secret', {
      db: { schema: 'purama_ai' }, global: { fetch: transport },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
        storageKey: `voice-settings-fixture-${++clientSequence}` },
    });
    const module = { exports: {} };
    runInNewContext(compiledVoice, { module, exports: module.exports,
      require: name => {
        if (name === '@/integrations/supabase/client') return { supabase: client };
        throw new Error(`Unmocked import: ${name}`);
      },
    }, { filename: sourcePath });
    return module.exports;
  }

  return {
    first: load(), second: load(), requests,
    holdOnce(match, phase = 'before') {
      const hold = { match, reached: latch(), release: latch(), used: false, phase };
      holds.push(hold);
      return { reached: hold.reached.promise, release: hold.release.resolve };
    },
    failOnce(match) { failures.push({ match, used: false }); },
  };
}

describe('voice settings concurrency with the frontend SDK and deterministic HTTP storage', { concurrency: false }, () => {
  it('a delayed speed save preserves a disable committed by another client', async () => {
    seed(owner, { enabled: true, auto_play: false });
    const h = fixture();
    const gate = h.holdOnce(request => request.method !== 'GET' && request.body.speed === 1.75);
    const pending = h.first.saveVoiceSettings(owner, { speed: 1.75 });
    await gate.reached;
    try {
      const disabled = await h.second.saveVoiceSettings(owner, { enabled: false });
      assert.equal(disabled.enabled, false);
    } finally { gate.release(); }
    const result = await pending;
    assertFields(stored(owner), { enabled: false, speed: 1.75 });
    assertFields(result, { enabled: false, speed: 1.75 });
    const writes = h.requests.filter(request => request.method !== 'GET');
    assert.deepEqual(writes.map(request => request.method), ['PATCH', 'PATCH']);
    assertPartialWrite(writes[0], { speed: 1.75 });
    assertPartialWrite(writes[1], { enabled: false });
  });

  it('independent language and speed saves do not overwrite each other', async () => {
    seed(owner, { language: 'fr', speed: 1 });
    const h = fixture();
    const gate = h.holdOnce(request => request.method !== 'GET' && request.body.speed === 1.25);
    const pending = h.first.saveVoiceSettings(owner, { speed: 1.25 });
    await gate.reached;
    try { await h.second.saveVoiceSettings(owner, { language: 'en' }); }
    finally { gate.release(); }
    await pending;
    assertFields(stored(owner), { language: 'en', speed: 1.25, auto_play: true });
  });

  it('a competing initial creation cannot overwrite a newly disabled setting', async () => {
    const h = fixture();
    // Delay the first insert until the second client has created a disabled row.
    const gate = h.holdOnce(request => request.method === 'POST');
    const pending = h.first.saveVoiceSettings(owner, { speed: 1.5 });
    await gate.reached;
    try {
      const disabled = await h.second.saveVoiceSettings(owner, { enabled: false });
      assert.equal(disabled.enabled, false);
    } finally { gate.release(); }
    await pending;
    assertFields(stored(owner), { enabled: false, speed: 1.5, auto_play: false });
    assert.equal(tableRows.size, 1);
    const initializations = h.requests.filter(request => request.method === 'POST');
    assert.equal(initializations.length, 2);
    for (const request of initializations) {
      assert.match(request.headers.get('prefer'), /resolution=ignore-duplicates/);
      assert.doesNotMatch(request.headers.get('prefer'), /resolution=merge-duplicates/);
      assert.equal(request.url.searchParams.get('on_conflict'), 'user_id');
    }
  });

  it('new-account creation retains the client auto-play default despite the legacy SQL default', async () => {
    assert.equal(sqlDefaults.auto_play, true);
    seed(other);
    assertFields(stored(other), { auto_play: true });
    const h = fixture();
    const result = await h.first.saveVoiceSettings(owner, { speed: 1.25 });
    assertFields(result, { user_id: owner, provider: 'openai', voice_id: 'nova',
      speed: 1.25, auto_play: false, enabled: true, language: 'fr' });
    assertFields(stored(owner), { auto_play: false, speed: 1.25 });
    assertFields(stored(other), { auto_play: true, speed: 1 });
  });

  it('a first disabled save is already disabled when the insert becomes visible', async () => {
    const h = fixture();
    const gate = h.holdOnce(request => request.method === 'POST', 'after');
    const pending = h.first.saveVoiceSettings(owner, { enabled: false });
    await gate.reached;
    try {
      assertFields(stored(owner), { enabled: false, auto_play: false });
    } finally { gate.release(); }
    assertFields(await pending, { enabled: false, auto_play: false });
  });

  it('an existing row keeps fields omitted from an ordinary settings patch', async () => {
    seed(owner, { provider: 'elevenlabs', voice_id: 'selected-voice', enabled: false,
      auto_play: true, language: 'de', speed: 0.75 });
    const h = fixture();
    const result = await h.first.saveVoiceSettings(owner, { language: 'en' });
    assertFields(result, { user_id: owner, provider: 'elevenlabs', voice_id: 'selected-voice',
      enabled: false, auto_play: true, language: 'en', speed: 0.75 });
    assert.equal(typeof result.speed, 'number');
    assert.equal(h.requests.length, 1);
    assertPartialWrite(h.requests[0], { language: 'en' });
  });

  it('a user_id inside the patch cannot retarget the owner or another user row', async () => {
    seed(owner, { language: 'fr', enabled: false });
    seed(other, { language: 'de', enabled: true });
    const h = fixture();
    const result = await h.first.saveVoiceSettings(owner, { user_id: other, language: 'en' });
    assertFields(result, { user_id: owner, language: 'en', enabled: false });
    assertFields(stored(owner), { user_id: owner, language: 'en', enabled: false });
    assertFields(stored(other), { user_id: other, language: 'de', enabled: true });
    for (const request of h.requests.filter(item => item.method === 'PATCH'))
      assert.equal(request.url.searchParams.get('user_id'), `eq.${owner}`);
  });

  it('a failed write rejects without changing the stored settings', async () => {
    seed(owner, { enabled: false, speed: 0.75 });
    const previous = stored(owner);
    const h = fixture();
    h.failOnce(request => request.method !== 'GET');
    await assert.rejects(h.first.saveVoiceSettings(owner, { speed: 1.5 }), { code: 'TEST_UNAVAILABLE' });
    assert.deepEqual(stored(owner), previous);
  });

  it('an initialization failure rejects and does not claim a saved new account', async () => {
    const h = fixture();
    h.failOnce(request => request.method === 'POST');
    await assert.rejects(h.first.saveVoiceSettings(owner, { enabled: false }), { code: 'TEST_UNAVAILABLE' });
    assert.equal(stored(owner), undefined);
  });

  it('a failed final patch after initialization rejects instead of reporting success', async () => {
    const h = fixture();
    h.failOnce(request => request.method === 'PATCH' && tableRows.has(owner));
    await assert.rejects(h.first.saveVoiceSettings(owner, { enabled: false }), { code: 'TEST_UNAVAILABLE' });
    assert.deepEqual(h.requests.map(request => request.method), ['PATCH', 'POST', 'PATCH']);
    // Creation succeeded, but the caller still receives the final write error.
    assertFields(stored(owner), { enabled: false, auto_play: false });
  });

  it('a missing row on the final patch after initialization is not reported as saved', async () => {
    const h = fixture();
    const gate = h.holdOnce(request => request.method === 'POST', 'after');
    const pending = h.first.saveVoiceSettings(owner, { enabled: false });
    await gate.reached;
    try {
      assertFields(stored(owner), { enabled: false, auto_play: false });
      // Model a concurrent deletion after the INSERT and before the final PATCH.
      tableRows.delete(owner);
    } finally { gate.release(); }
    await assert.rejects(pending, /Voice settings could not be saved\./);
    assert.deepEqual(h.requests.map(request => request.method), ['PATCH', 'POST', 'PATCH']);
    assert.equal(stored(owner), undefined);
  });
});
