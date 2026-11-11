import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const sourcePath = fileURLToPath(new URL('../../src/lib/email-agent.ts', import.meta.url));
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SETTINGS = {
  is_active: false, autonomy_level: 2, tone: 'professionnel_amical', custom_tone_prompt: null,
  signature: '', language: 'fr', excluded_emails: [], excluded_domains: [],
  auto_reply_categories: ['confirmation', 'remerciement', 'faq'],
  notify_categories: ['urgent', 'important', 'partenariat', 'facturation'],
  archive_categories: ['newsletter', 'spam', 'promo'],
  working_hours_only: false, working_hours_start: '08:00', working_hours_end: '19:00',
  daily_digest: true, daily_digest_time: '08:00', vacation_mode: false, vacation_message: null,
};
const METADATA = {
  id: 'fixture-config', user_id: OWNER, gmail_email: 'original@fixture.invalid',
  last_sync_at: '2026-11-01T00:00:00.000Z', total_processed: 10, total_auto_replied: 2,
  total_drafted: 3, total_notified: 4, total_archived: 1, estimated_time_saved_minutes: 20,
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z',
};
// These strings are synthetic ciphertext stand-ins, never provider credentials.
const PRIVATE = {
  gmail_access_token: 'fixture-old-encrypted-access',
  gmail_refresh_token: 'fixture-old-encrypted-refresh',
  gmail_token_expiry: '2026-11-02T00:00:00.000Z',
  last_email_id: 'fixture-worker-cursor', future_private_column: 'fixture-private',
};
const PUBLIC_KEYS = [...Object.keys(SETTINGS), ...Object.keys(METADATA)].sort();
const clone = value => JSON.parse(JSON.stringify(value));

// Execute the real frontend module. The only imports it can resolve are inert
// Supabase/OAuth ports; no browser, provider, network or process API is supplied.
function harness(options = {}) {
  let row = options.missing ? null : { ...clone(SETTINGS), ...METADATA, ...PRIVATE };
  const otherRow = { ...clone(SETTINGS), ...METADATA, user_id: OTHER, gmail_email: 'other@fixture.invalid' };
  const queries = [];
  const writes = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'email_agent_config');
      let operation = 'read';
      let payload;
      let columns = '*';
      const filters = {};
      function execute() {
        queries.push({ operation, columns, filters: { ...filters } });
        if (operation === 'read' && options.readError) return { data: null, error: options.readError };
        if (operation !== 'read') {
          writes.push({ operation, payload: clone(payload), filters: { ...filters } });
          if (options.writeError) return { data: null, error: options.writeError };
          if (operation === 'insert') {
            if (options.insertError) return { data: null, error: options.insertError };
            if (row) return { data: null, error: { code: '23505' } };
            row = { ...clone(SETTINGS), ...METADATA, ...PRIVATE, gmail_email: null,
              gmail_access_token: null, gmail_refresh_token: null, ...clone(payload) };
          } else if (row && filters.user_id === row.user_id) {
            row = { ...row, ...clone(payload) };
          } else {
            return { data: null, error: { code: 'PGRST116' } };
          }
        }
        if (!row || (operation === 'read' && filters.user_id !== row.user_id)) {
          return { data: null, error: null };
        }
        let result = clone(row);
        if (operation !== 'read' && options.receipt) result = options.receipt(result);
        if (result && columns !== '*') {
          result = Object.fromEntries(columns.split(',').map(key => [key.trim(), result[key.trim()]]));
        }
        return { data: result, error: null };
      }
      const query = {
        select(value = '*') { columns = value; return query; },
        eq(key, value) { filters[key] = value; return query; },
        insert(value) { operation = 'insert'; payload = value; return query; },
        update(value) { operation = 'update'; payload = value; return query; },
        maybeSingle: async () => execute(),
        single: async () => execute(),
      };
      return query;
    },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);
  runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(specifier) {
      if (specifier === '@/integrations/supabase/client') return { supabase };
      if (specifier === '@/lib/oauth-google') return {
        invokeOAuth() { throw new Error('Unexpected OAuth call'); },
        storeOAuthContext() { throw new Error('Unexpected OAuth state write'); },
      };
      throw new Error('Unexpected import: ' + specifier);
    },
  }, { filename: sourcePath });
  return {
    api: module.exports, queries, writes,
    row: () => clone(row), otherRow: () => clone(otherRow),
    providerUpdate(values) { row = { ...row, ...values }; },
  };
}

function assertPublic(row) {
  assert.deepEqual(Object.keys(row).sort(), PUBLIC_KEYS);
  for (const key of Object.keys(PRIVATE)) assert.equal(Object.hasOwn(row, key), false, key);
}

test('config read requests public metadata without credentials or worker cursors', async () => {
  const h = harness();
  const row = await h.api.getConfig(OWNER);
  assertPublic(row);
  assert.equal(row.gmail_email, METADATA.gmail_email);
  assert.equal(row.total_processed, 10);
  assert.equal(h.queries[0].filters.user_id, OWNER);
  assert.notEqual(h.queries[0].columns, '*');
  assert.equal(h.writes.length, 0);
});

test('first config creation returns the same public projection and existing defaults', async () => {
  const h = harness({ missing: true });
  const row = await h.api.getConfig(OWNER);
  assertPublic(row);
  for (const [key, value] of Object.entries(SETTINGS)) assert.deepEqual(row[key], value, key);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].operation, 'insert');
  assert.equal(h.writes[0].payload.user_id, OWNER);
  assert.ok(h.queries.every(query => query.columns !== '*'));
});

test('all editable settings including false, null and empty arrays remain writable', async () => {
  const h = harness();
  const settings = { ...SETTINGS, autonomy_level: 4, language: 'en', signature: 'Saved signature',
    working_hours_only: true, daily_digest: false, vacation_message: null,
    excluded_emails: ['ignored@fixture.invalid'], auto_reply_categories: [] };
  const result = await h.api.updateConfig(OWNER, settings);
  assert.deepEqual(h.writes[0].payload, settings);
  assert.equal(h.writes[0].filters.user_id, OWNER);
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(result[key], value, key);
  assertPublic(result);
});

test('saving a stale config after reconnection preserves the fresh Gmail credentials and metadata', async () => {
  const h = harness();
  const stale = await h.api.getConfig(OWNER);
  const fresh = {
    gmail_email: 'reconnected@fixture.invalid', gmail_access_token: 'fixture-new-encrypted-access',
    gmail_refresh_token: 'fixture-new-encrypted-refresh', gmail_token_expiry: '2026-11-03T00:00:00.000Z',
    last_sync_at: '2026-11-02T00:00:00.000Z', last_email_id: 'fixture-new-cursor',
    total_processed: 99, total_auto_replied: 20, total_drafted: 30, total_notified: 40,
    total_archived: 9, estimated_time_saved_minutes: 198,
  };
  h.providerUpdate(fresh);
  // The settings page removes declared read-only metadata before saving. The
  // runtime row's undeclared credential fields still survive that object rest.
  const patch = Object.fromEntries(Object.entries(stale).filter(([key]) => !Object.hasOwn(METADATA, key)));
  const result = await h.api.updateConfig(OWNER, { ...patch, signature: 'New signature' });
  for (const [key, value] of Object.entries(fresh)) assert.deepEqual(h.row()[key], value, key);
  assert.equal(result.signature, 'New signature');
  assert.equal(result.gmail_email, fresh.gmail_email);
  assertPublic(result);
});

test('runtime whitelist blocks ownership, provider fields, counters, timestamps and unknown columns', async () => {
  const h = harness();
  const before = h.row();
  const otherBefore = h.otherRow();
  await h.api.updateConfig(OWNER, {
    signature: 'Allowed', id: 'replacement-id', user_id: OTHER, gmail_email: 'forged@fixture.invalid',
    gmail_access_token: 'fixture-forged-access', gmail_refresh_token: 'fixture-forged-refresh',
    gmail_token_expiry: null, last_sync_at: null, last_email_id: 'replacement-cursor',
    total_processed: 0, total_auto_replied: 0, total_drafted: 0, total_notified: 0,
    total_archived: 0, estimated_time_saved_minutes: 0, created_at: null, updated_at: null,
    future_private_column: 'replacement',
  });
  assert.deepEqual(h.writes[0].payload, { signature: 'Allowed' });
  assert.deepEqual(h.row(), { ...before, signature: 'Allowed' });
  assert.deepEqual(h.otherRow(), otherBefore);
});

test('protected-only and empty patches fail before any database mutation', async () => {
  for (const patch of [{ gmail_email: null, user_id: OTHER }, {}, { signature: undefined }]) {
    const h = harness();
    await assert.rejects(h.api.updateConfig(OWNER, patch));
    assert.equal(h.writes.length, 0);
  }
});

test('inherited properties never become settings writes', async () => {
  const h = harness();
  const patch = Object.assign(Object.create({ signature: 'Inherited value', user_id: OTHER }), { language: 'es' });
  await h.api.updateConfig(OWNER, patch);
  assert.deepEqual(h.writes[0].payload, { language: 'es' });
});

test('read errors remain errors and do not trigger default creation', async () => {
  const error = { code: 'fixture-read-failure' };
  const h = harness({ readError: error });
  await assert.rejects(h.api.getConfig(OWNER), actual => actual === error);
  assert.equal(h.writes.length, 0);
});

test('write errors cannot be acknowledged as saved settings', async () => {
  const error = { code: 'fixture-write-failure' };
  const h = harness({ writeError: error });
  await assert.rejects(h.api.updateConfig(OWNER, { signature: 'Not saved' }), actual => actual === error);
  assert.equal(h.row().signature, '');
});

test('a concurrent first-creation conflict remains visible and never retries as an overwrite', async () => {
  const error = { code: '23505' };
  const h = harness({ missing: true, insertError: error });
  await assert.rejects(h.api.getConfig(OWNER), actual => actual === error);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].operation, 'insert');
});

test('explicit Gmail disconnection only clears the display account and disables the agent', async () => {
  const h = harness();
  const before = h.row();
  await h.api.disconnectGmail(OWNER);
  assert.deepEqual(h.writes[0].payload, { gmail_email: null, is_active: false });
  assert.deepEqual(h.writes[0].filters, { user_id: OWNER });
  assert.deepEqual(h.row(), { ...before, gmail_email: null, is_active: false });
  assert.notEqual(h.queries[0].columns, '*');
  assert.ok(h.queries[0].columns.split(',').every(key => !Object.hasOwn(PRIVATE, key)));
});

test('Gmail disconnection rejects missing, foreign or contradictory write receipts', async () => {
  for (const receipt of [() => null, row => ({ ...row, user_id: OTHER }),
    row => ({ ...row, gmail_email: 'still-connected@fixture.invalid' }), row => ({ ...row, is_active: true })]) {
    const h = harness({ receipt });
    await assert.rejects(h.api.disconnectGmail(OWNER));
  }
});

test('Gmail disconnection propagates a rejected database write', async () => {
  const error = { code: 'fixture-disconnect-failure' };
  const h = harness({ writeError: error });
  await assert.rejects(h.api.disconnectGmail(OWNER), actual => actual === error);
  assert.equal(h.row().gmail_email, METADATA.gmail_email);
});
