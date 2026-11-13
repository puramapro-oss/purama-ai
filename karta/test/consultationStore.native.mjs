import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';

// Same explicit disposable PostgreSQL 18 gate as subscriptionTrial.native.
// Never infer credentials or a target from application/DATABASE_URL settings.
const host = process.env.PURAMA_TRIAL_TEST_PG_HOST;
assert(host && (host === '127.0.0.1' || host.startsWith('/')), 'Explicit local test host required');
const expectedData = process.env.PURAMA_TRIAL_TEST_PG_DATA;
assert(expectedData, 'Explicit disposable data directory required');
const port = Number(process.env.PURAMA_TRIAL_TEST_PG_PORT || 5432);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
const connection = { host, port, user: process.env.PURAMA_TRIAL_TEST_PG_USER || 'postgres',
  password: () => process.env.PURAMA_TRIAL_TEST_PG_PASSWORD || '', ssl: false,
  options: '-c search_path=pg_catalog', database: 'postgres', connectionTimeoutMillis: 5000, statement_timeout: 12000 };
const suffix = randomUUID().replaceAll('-', '');
const database = `purama_consultation_test_${suffix}`;
assert(/^purama_consultation_test_[0-9a-f]{32}$/.test(database));
const owner = '00000000-0000-4000-8000-000000000951';
const other = '00000000-0000-4000-8000-000000000952';
const clients = new Set();
let cluster, admin, created = false;
const plan = { model: 'qualified-model', reflection: 'standard', speed: 'standard', maxOutputTokens: 1024,
  timeoutMs: 60000, research: { maxSearches: 1, maxPages: 2, maxReviewers: 1, maxRounds: 1, concurrency: 2 }, providerOptions: {} };
const estimates = { policyVersion: 'native-fixture-v1', calls: [
  { kind: 'synthesis', provider: 'anthropic', model: 'qualified-model', maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 50 },
] };
const request = operationId => ({ operationId, userId: owner, question: 'Private fixture', preferences: { model: 'qualified-model', reflection: 'auto', speed: 'standard' }, reviewerModels: [], research: { queries: [], urls: [] } });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function connect(label, target = database) {
  const client = new pg.Client({ ...connection, database: target, application_name: `consultation_${suffix.slice(0, 8)}_${label}` });
  await client.connect(); clients.add(client);
  assert(Number.isInteger(client.processID)); return client;
}
async function close(client) { if (client && clients.has(client)) { try { await client.end(); } finally { clients.delete(client); } } }
async function service(label) { const client = await connect(label); await client.query('SET ROLE service_role'); return client; }
const observe = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code }));
async function scalar(client, sql, values = []) { return (await client.query(sql, values)).rows[0].value; }
async function provision(cost = 100) {
  return scalar(admin, "SELECT purama_ai.model_consultation_provision($1,10000,$2,'2099-01-01',4) AS value", [owner, cost]);
}
async function begin(client, id = 'op-1') {
  const value = request(id);
  return scalar(client, 'SELECT purama_ai.model_consultation_create($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) AS value', [owner, id, hash(value), JSON.stringify(value), JSON.stringify(plan), JSON.stringify(estimates)]);
}
const cancel = (client, id = 'op-1') => scalar(client, 'SELECT purama_ai.model_consultation_cancel($1,$2) AS value', [owner, id]);
async function waitForBlocked(blocked) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const rows = (await admin.query('SELECT pid,wait_event_type FROM pg_stat_activity WHERE datname=$1 AND pid=ANY($2::integer[])', [database, blocked.map(client => client.processID)])).rows;
    if (rows.length === blocked.length && rows.every(row => row.wait_event_type === 'Lock')) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Competing backends must actually wait on PostgreSQL locks');
}

before(async () => {
  cluster = await connect('cluster', 'postgres');
  const settings = (await cluster.query("SELECT current_database() AS database,current_user AS username,current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,current_setting('server_version_num')::int AS version,inet_server_addr() AS address")).rows[0];
  assert.equal(settings.database, 'postgres'); assert.equal(settings.username, connection.user); assert.equal(settings.data, expectedData);
  assert(settings.version >= 180000 && settings.version < 190000, 'Disposable PostgreSQL 18 required');
  if (host.startsWith('/')) { assert.equal(settings.listen, ''); assert.equal(settings.address, null); }
  const roles = (await cluster.query('SELECT rolname,rolsuper,rolcanlogin,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [['anon', 'authenticated', 'service_role']])).rows;
  assert.deepEqual(roles, ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname, rolsuper: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: rolname === 'service_role' })), 'Fixture roles must already be owned by subscription qualification');
  assert.equal((await cluster.query('SELECT 1 FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) OR member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))', [['anon', 'authenticated', 'service_role']])).rowCount, 0);
  await cluster.query(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true;
  admin = await connect('admin');
  assert.equal((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','purama_ai')")).rowCount, 0);
  await admin.query(`CREATE SCHEMA auth; CREATE SCHEMA purama_ai; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth,purama_ai TO anon,authenticated,service_role;`);
  for (const file of [
    '008_chef_control_plane.sql', '009_chef_hardening.sql', '010_chef_reliability.sql', '011_chef_runtime_policy.sql',
    '012_chef_mission_ingest.sql', '013_chef_independent_review.sql', '014_chef_file_ownership.sql', '015_chef_mission_file_ownership.sql',
    '016_chef_scoped_evidence.sql', '017_chef_evidence_generation.sql', '021_chef_budget_admission.sql', '022_chef_mission_estimates.sql',
    '023_chef_process_quarantine.sql', '024_chef_claim_budget_reconciliation.sql', '031_model_consultation.sql',
  ]) await admin.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
});
after(async () => {
  try {
    const results = await Promise.allSettled([...clients].filter(client => client !== cluster).map(close));
    if (created) { assert(/^purama_consultation_test_[0-9a-f]{32}$/.test(database)); await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`); created = false; }
    const failed = results.find(value => value.status === 'rejected'); if (failed) throw failed.reason;
  } finally { await close(cluster); }
});
beforeEach(async () => { await admin.query('TRUNCATE auth.users CASCADE'); await admin.query('INSERT INTO auth.users VALUES($1),($2)', [owner, other]); });

test('two real connections claim one operation and one financial envelope', { timeout: 30000 }, async () => {
  await provision(); const gate = await connect('same_gate'), first = await service('same_first'), second = await service('same_second');
  let calls = [];
  try {
    await gate.query('BEGIN'); await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('consultation:'||$1::text||':op-1',0))", [owner]);
    calls = [observe(begin(first)), observe(begin(second))]; await waitForBlocked([first, second]); await gate.query('COMMIT');
    const outcomes = await Promise.all(calls); assert(outcomes.every(value => value.ok));
    assert.equal(outcomes.filter(value => value.value.created).length, 1);
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations'), 1);
  } finally { await gate.query('ROLLBACK').catch(() => {}); await Promise.all(calls); await Promise.all([gate, first, second].map(close)); }
});
test('two envelopes cannot both spend the final shared budget', { timeout: 30000 }, async () => {
  const mission = await provision(50); const gate = await connect('budget_gate'), first = await service('budget_first'), second = await service('budget_second');
  let calls = [];
  try {
    await gate.query('BEGIN'); await gate.query('SELECT id FROM purama_ai.chef_missions WHERE id=$1 FOR UPDATE', [mission]);
    calls = [observe(begin(first, 'op-a')), observe(begin(second, 'op-b'))]; await waitForBlocked([first, second]); await gate.query('COMMIT');
    const outcomes = await Promise.all(calls);
    assert.equal(outcomes.filter(value => value.ok).length, 1); assert.equal(outcomes.find(value => !value.ok)?.code, 'PCO02');
    assert.equal(await scalar(admin, 'SELECT sum(reserved_cost_micros)::int AS value FROM purama_ai.chef_budget_reservations'), 50);
  } finally { await gate.query('ROLLBACK').catch(() => {}); await Promise.all(calls); await Promise.all([gate, first, second].map(close)); }
});
test('cancel commits before a waiting begin without fabricating any budget', { timeout: 30000 }, async () => {
  const canceller = await service('cancel_first'), later = await service('begin_later'); let pending;
  try {
    await canceller.query('BEGIN'); assert.equal((await cancel(canceller)).state, 'cancelled');
    pending = observe(begin(later)); await waitForBlocked([later]); await canceller.query('COMMIT');
    const outcome = await pending; assert(outcome.ok); assert.equal(outcome.value.created, false); assert.equal(outcome.value.operation.state, 'cancelled');
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations'), 0);
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.chef_missions'), 0);
  } finally { await canceller.query('ROLLBACK').catch(() => {}); if (pending) await pending; await Promise.all([canceller, later].map(close)); }
});
test('cancel waiting behind begin prevents its first provider admission', { timeout: 30000 }, async () => {
  await provision(); const starter = await service('begin_first'), canceller = await service('cancel_later'); let pending;
  try {
    await starter.query('BEGIN'); const createdOp = await begin(starter);
    pending = observe(cancel(canceller)); await waitForBlocked([canceller]); await starter.query('COMMIT');
    const outcome = await pending; assert(outcome.ok); assert.equal(outcome.value.state, 'cancelled');
    assert.equal(await scalar(starter, 'SELECT purama_ai.model_consultation_start($1,$2,$3,$4) AS value', [owner, 'op-1', hash(request('op-1')), createdOp.generation]), false);
    const reserved = (await admin.query('SELECT actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations')).rows[0];
    assert.equal(Number(reserved.actual_input_tokens), 0); assert.equal(Number(reserved.actual_cost_micros), 0);
  } finally { await starter.query('ROLLBACK').catch(() => {}); if (pending) await pending; await Promise.all([starter, canceller].map(close)); }
});
test('concurrent identical provider reconciliation charges existing CHEF totals once', { timeout: 30000 }, async () => {
  await provision(); const setup = await service('prepare'); const op = await begin(setup);
  const binding = [owner, 'op-1', op.generation];
  await scalar(setup, 'SELECT purama_ai.model_consultation_start($1,$2,$3,$4) AS value', [owner, 'op-1', hash(request('op-1')), op.generation]);
  const call = { userId: owner, operationId: 'op-1', callId: 'op-1:1', kind: 'synthesis', provider: 'anthropic', model: 'qualified-model', inputHash: 'a'.repeat(64), maxOutputTokens: 1024 };
  await scalar(setup, 'SELECT purama_ai.model_consultation_reserve($1,$2,$3,$4::jsonb) AS value', [...binding, JSON.stringify(call)]);
  const usage = { version: 1, apiFormat: 'anthropic_messages', routeKind: 'anthropic', requestedModel: 'qualified-model', responseModel: 'qualified-model', responseId: 'msg_local', inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 0 };
  await scalar(setup, 'SELECT purama_ai.model_consultation_settle($1,$2,$3,$4::jsonb) AS value', [...binding, JSON.stringify({ call, status: 'completed', usage: [usage] })]);
  await scalar(setup, 'SELECT purama_ai.model_consultation_finalize($1,$2,$3,$4::jsonb) AS value', [...binding, JSON.stringify({ status: 'complete', reason: 'completed', plan, answer: 'Observed private result', citedSourceIds: [], disagreements: [], uncertainties: [], sources: [], receipts: [], verificationStatus: 'unverified' })]);
  const gate = await connect('reconcile_gate'), first = await service('reconcile_first'), second = await service('reconcile_second'); let calls = [];
  const reconcile = client => scalar(client, "SELECT purama_ai.model_consultation_reconcile($1,'op-1','invoice-observed',10,5,0,37) AS value", [owner]);
  try {
    await gate.query('BEGIN'); await gate.query("SELECT id FROM purama_ai.model_consultations WHERE user_id=$1 AND operation_id='op-1' FOR UPDATE", [owner]);
    calls = [observe(reconcile(first)), observe(reconcile(second))]; await waitForBlocked([first, second]); await gate.query('COMMIT');
    assert((await Promise.all(calls)).every(outcome => outcome.ok && outcome.value.resourceState === 'reconciled'));
    const totals = (await admin.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE kind='consultation'")).rows[0];
    assert.equal(Number(totals.tokens_used), 15); assert.equal(Number(totals.cost_used_micros), 37);
  } finally { await gate.query('ROLLBACK').catch(() => {}); await Promise.all(calls); await Promise.all([setup, gate, first, second].map(close)); }
});
