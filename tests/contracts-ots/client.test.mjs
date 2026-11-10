import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url); const ts = require('typescript');
const source = readFileSync(new URL('../../src/pages/AdminContracts.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AdminContracts.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleVerifyOts') declaration = node; ts.forEachChild(node, visit); }
visit(ast); assert.ok(declaration, 'test must execute the actual handler declaration');
const javascript = ts.transpileModule(declaration.getText(ast).replace('import.meta.env.VITE_SUPABASE_URL', 'TEST_SUPABASE_URL'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness({ response, sessionWait, fetchWait } = {}) {
  const state = { active: true, requests: 0, notifications: [], mutations: 0, rows: [{ id: 'contract-a' }, { id: 'contract-b' }] };
  const context = { Symbol, Number, Date, encodeURIComponent, Error, TEST_SUPABASE_URL: 'https://fixture.invalid', user: { id: 'account-a' },
    captureOtsScope: () => () => state.active, latestOtsRequest: { current: null },
    supabase: { auth: { getSession: async () => sessionWait ? sessionWait.promise : { data: { session: { user: { id: 'account-a' }, access_token: 'fixture' } } } } },
    fetch: async () => { state.requests++; return fetchWait ? fetchWait.promise : response; },
    toast: Object.fromEntries(['success', 'info', 'error'].map(kind => [kind, message => state.notifications.push({ kind, message })])),
    setContracts: change => { state.rows = change(state.rows); state.mutations++; },
  };
  vm.createContext(context); vm.runInContext(javascript, context);
  return { state, run: id => context.handleVerifyOts({ id }) };
}
const verified = () => Response.json({ verified: true, block_height: 358391, btc_timestamp: '2015-05-28T15:41:18.000Z' });
test('HTTP failure cannot be presented as pending or a successful verification', async () => {
  const h = harness({ response: Response.json({ error: 'fixture error' }, { status: 503 }) }); await h.run('contract-a');
  assert.equal(h.state.notifications.at(-1).kind, 'error'); assert.equal(h.state.mutations, 0);
});
test('only explicit pending confirmation is presented as pending', async () => {
  const h = harness({ response: Response.json({ verified: false, pending: true }) }); await h.run('contract-a');
  assert.equal(h.state.notifications.at(-1).kind, 'info'); assert.equal(h.state.mutations, 0);
});
test('a validated successful response updates only its contract', async () => {
  const h = harness({ response: verified() }); await h.run('contract-a');
  assert.equal(h.state.notifications.at(-1).kind, 'success'); assert.equal(h.state.rows[0].ots_block_height, 358391); assert.equal(h.state.rows[1].ots_block_height, undefined);
});
test('unknown response shape or invalid Bitcoin fields are errors', async () => {
  for (const data of [{}, { verified: true, block_height: '358391', btc_timestamp: 'not-a-date' }]) {
    const h = harness({ response: Response.json(data) }); await h.run('contract-a'); assert.equal(h.state.notifications.at(-1).kind, 'error'); assert.equal(h.state.mutations, 0);
  }
});
test('scope invalidation while awaiting the session prevents the follow-up request', async () => {
  const wait = deferred(); const h = harness({ sessionWait: wait }); const pending = h.run('contract-a'); h.state.active = false;
  wait.resolve({ data: { session: { user: { id: 'account-a' }, access_token: 'fixture' } } }); await pending;
  assert.equal(h.state.requests, 0); assert.equal(h.state.notifications.length, 0);
});
test('account or selected-contract scope invalidation suppresses late response effects', async () => {
  const wait = deferred(); const h = harness({ fetchWait: wait }); const pending = h.run('contract-a'); await Promise.resolve(); h.state.active = false;
  const before = h.state.notifications.length; wait.resolve(verified()); await pending;
  assert.equal(h.state.notifications.length, before); assert.equal(h.state.mutations, 0);
});
test('a newer verification invalidates the earlier request even within the same account', async () => {
  const wait = deferred(); const h = harness({ fetchWait: wait }); const first = h.run('contract-a'); await Promise.resolve(); const second = h.run('contract-b'); await Promise.resolve();
  wait.resolve(verified()); await Promise.all([first, second]);
  assert.equal(h.state.notifications.filter(x => x.kind === 'success').length, 1); assert.equal(h.state.rows[0].ots_block_height, undefined); assert.equal(h.state.rows[1].ots_block_height, 358391);
});
