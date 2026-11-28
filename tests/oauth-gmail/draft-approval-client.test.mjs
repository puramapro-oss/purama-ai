import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const log = '00000000-0000-4000-8000-000000000011';
const approval = '00000000-0000-4000-8000-000000000021';
const action = '00000000-0000-4000-8000-000000000031';
const preview = { approval_id: approval, user_id: owner, log_id: log,
  expires_at: new Date(Date.now() + 600_000).toISOString(), payload: {
    gmail_email: 'owner@example.invalid', gmail_message_id: 'parent-1', gmail_thread_id: 'thread-1',
    gmail_draft_id: 'draft-1', recipient: 'recipient@example.invalid', subject: 'Objet exact',
    body: 'Texte intégral '.repeat(5000) + 'FIN EXACTE',
  } };
const receipt = { ok: true, status: 'sent', action_id: action, provider_message_id: 'provider-receipt-1', matches_current_preview: true };

function harness(options = {}) {
  const calls = [];
  const writes = [];
  const queries = [];
  let currentOwner = options.owner ?? owner;
  let response = options.response ?? { ok: true, status: 'ready', ...preview };
  const supabase = {
    auth: { getSession: async () => {
      await options.sessionGate;
      return { data: { session: { user: { id: currentOwner }, access_token: 'fixture-only-token' } }, error: null };
    } },
    functions: { invoke: async (name, options) => {
      calls.push({ name, body: JSON.parse(JSON.stringify(options.body)), headers: { ...options.headers }, signal: options.signal });
      return { data: response, error: null };
    } },
    from: table => {
      const filters = {};
      let payload;
      const query = {
        update(value) { payload = value; return query; },
        eq(key, value) { filters[key] = value; return query; },
        select() { return query; },
        order() { return query; },
        limit() { return query; },
        or(value) { filters.or = value; return query; },
        then(resolve) { queries.push({ table, filters: { ...filters } }); return Promise.resolve({ data: [], count: 0, error: null }).then(resolve); },
        async single() {
          writes.push({ table, filters: { ...filters }, payload: { ...payload } });
          return { data: options.rejectReceipt ?? { id: log, user_id: owner, user_approved: false }, error: null };
        },
      };
      return query;
    },
  };
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(new URL('../../src/lib/email-agent.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.length ?? 0, 0);
  runInNewContext(compiled.outputText, { module, exports: module.exports,
    require(name) {
      if (name === '@/integrations/supabase/client') return { supabase };
      if (name === '@/lib/oauth-google') return {};
      throw new Error('Unexpected import: ' + name);
    },
  });
  return { api: module.exports, calls, writes, queries, setOwner(value) { currentOwner = value; }, setResponse(value) { response = value; } };
}

test('the actual client requests an owner-bound complete server preview', async () => {
  const h = harness();
  const value = await h.api.getDraftPreview(owner, log);
  assert.equal(value.payload.body, preview.payload.body);
  assert.equal(value.approval_id, approval);
  assert.deepEqual(h.calls.map(call => call.body), [{ action: 'preview', user_id: owner, log_id: log }]);
  assert.equal(h.writes.length, 0);
});
test('a mismatched preview owner, log or incomplete body is never admitted', async () => {
  for (const patch of [{ user_id: other }, { log_id: other }, { payload: { ...preview.payload, body: null } },
    { status: 'sent' }, { approval_id: null }]) {
    const h = harness({ response: { ok: true, status: 'ready', ...preview, ...patch } });
    await assert.rejects(h.api.getDraftPreview(owner, log));
  }
});
test('account change prevents invocation of approval, send and reconciliation', async () => {
  const h = harness({ owner: other });
  await assert.rejects(h.api.approveLog(preview));
  await assert.rejects(h.api.sendDraft(preview));
  await assert.rejects(h.api.reconcileDraft(owner, log));
  assert.equal(h.calls.length, 0); assert.equal(h.writes.length, 0);
});
test('aborting during session lookup prevents a later endpoint request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ sessionGate: gate });
  const controller = new AbortController();
  const pending = h.api.approveLog(preview, undefined, controller.signal);
  controller.abort(); release();
  await assert.rejects(pending); assert.equal(h.calls.length, 0);
});
test('approval submits only the immutable version and checks the exact approval receipt', async () => {
  const h = harness({ response: { ok: true, status: 'approved', user_id: owner, log_id: log, approval_id: approval } });
  await h.api.approveLog(preview, 'Ma validation');
  assert.deepEqual(h.calls[0].body, { action: 'approve', user_id: owner, log_id: log, approval_id: approval, feedback: 'Ma validation' });
  assert.equal(h.writes.length, 0);
  h.setResponse({ ok: true, status: 'approved', user_id: owner, log_id: log, approval_id: other });
  await assert.rejects(h.api.approveLog(preview));
});
test('a 2xx response without a durable provider receipt is never a send success', async () => {
  for (const response of [{ ok: true, status: 'sent' }, { ...receipt, status: 'unknown' },
    { ...receipt, provider_message_id: '' }, { ...receipt, ok: false }, { ...receipt, matches_current_preview: undefined }]) {
    const h = harness({ response });
    await assert.rejects(h.api.sendDraft(preview));
    assert.deepEqual(h.calls[0].body, { action: 'send', user_id: owner, log_id: log, approval_id: approval });
  }
});
test('confirmed send exposes only its verified receipt', async () => {
  const h = harness({ response: receipt });
  const value = await h.api.sendDraft(preview);
  assert.equal(value.action_id, action); assert.equal(value.provider_message_id, receipt.provider_message_id);
  assert.equal(value.matches_current_preview, true);
  h.setResponse({ ...receipt, matches_current_preview: false });
  assert.equal((await h.api.sendDraft(preview)).matches_current_preview, false);
});
test('reconciliation preserves the distinction between an older send and the current draft', async () => {
  const h = harness({ response: { ...receipt, reconciled: true, matches_current_preview: false } });
  const value = await h.api.reconcileDraft(owner, log);
  assert.equal(value.matches_current_preview, false);
  assert.equal(h.calls[0].name, 'email-agent-reconcile-draft');
  assert.deepEqual(h.calls[0].body, { log_id: log });
  h.setResponse({ ...receipt, reconciled: true, matches_current_preview: undefined });
  await assert.rejects(h.api.reconcileDraft(owner, log));
});
test('reject targets the expected owner and requires a persisted receipt', async () => {
  const h = harness(); await h.api.rejectLog(log, owner, 'Refus');
  assert.deepEqual(h.writes[0].filters, { id: log, user_id: owner });
  assert.equal(h.writes[0].payload.user_approved, false);
  const wrong = harness({ rejectReceipt: { id: log, user_id: other, user_approved: false } });
  await assert.rejects(wrong.api.rejectLog(log, owner));
});
test('pending list and counter include approved drafts awaiting a send, excluding rejected drafts', async () => {
  const h = harness();
  await h.api.listLogs(owner, { pendingOnly: true });
  await h.api.pendingDraftsCount(owner);
  assert.equal(h.queries.length, 2);
  for (const query of h.queries) assert.deepEqual(query.filters, {
    user_id: owner, action_taken: 'draft', or: 'user_approved.is.null,user_approved.eq.true',
  });
});
