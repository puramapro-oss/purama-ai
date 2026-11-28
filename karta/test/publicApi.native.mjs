import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';

// Explicit disposable native PostgreSQL qualification. Never infer a target
// or credentials from DATABASE_URL, Supabase or application configuration.
const host = process.env.PURAMA_API_TEST_PG_HOST;
const expectedData = process.env.PURAMA_API_TEST_PG_DATA;
const port = Number(process.env.PURAMA_API_TEST_PG_PORT);
assert.equal(process.env.PURAMA_API_TEST_PG_CONFIRM, 'disposable');
assert(host && (host === '127.0.0.1' || host.startsWith('/')), 'Explicit loopback/socket host required');
assert(expectedData && isAbsolute(expectedData), 'Explicit disposable data directory required');
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Explicit test port required');
const connection = { host, port, user: process.env.PURAMA_API_TEST_PG_USER || 'postgres',
  password: () => process.env.PURAMA_API_TEST_PG_PASSWORD || '', database: 'postgres', ssl: false,
  options: '-c search_path=pg_catalog', connectionTimeoutMillis: 5000, statement_timeout: 12000 };
const suffix = randomUUID().replaceAll('-', '');
const database = `purama_api_test_${suffix}`;
assert(/^purama_api_test_[0-9a-f]{32}$/.test(database));
const owner = '00000000-0000-4000-8000-000000000971';
const external = '00000000-0000-4000-8000-000000000972';
const allScopes = ['catalog', 'read', 'create', 'cancel'];
const clients = new Set();
let cluster, admin, created = false;
const plan = { model: 'qualified-model', reflection: 'standard', speed: 'standard', maxOutputTokens: 1024,
  timeoutMs: 60000, research: { maxSearches: 0, maxPages: 0, maxReviewers: 0, maxRounds: 1, concurrency: 1 }, providerOptions: {} };
const estimates = { policyVersion: 'native-api-fixture-v1', calls: [
  { kind: 'synthesis', provider: 'anthropic', model: 'qualified-model', maxCalls: 2, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 25 },
] };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = internal => ({ operationId: internal, userId: owner, question: 'Native SQL fixture',
  preferences: { model: 'qualified-model', reflection: 'auto', speed: 'standard' }, reviewerModels: [], research: { queries: [], urls: [] } });
const identity = internal => ({ p_user_id: owner, p_operation_id: internal });
const observe = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: error.code }));
async function connect(label, target = database) {
  const client = new pg.Client({ ...connection, database: target, application_name: `api_${suffix.slice(0, 8)}_${label}` });
  await client.connect(); clients.add(client); assert(Number.isInteger(client.processID)); return client;
}
async function close(client) {
  if (client && clients.has(client)) { try { await client.end(); } finally { clients.delete(client); } }
}
async function service(label) { const client = await connect(label); await client.query('SET ROLE service_role'); return client; }
async function scalar(client, sql, values = []) { return (await client.query(sql, values)).rows[0].value; }
async function credential({ projectId, rate = 60 } = {}) {
  projectId ??= await scalar(admin, `INSERT INTO purama_ai.iao_api_projects
    (user_id,name,expires_at,allowed_models,max_operation_cost_micros,requests_per_minute)
    VALUES($1,'Native API fixture','2099-01-01',ARRAY['qualified-model'],100,$2) RETURNING id AS value`, [owner, rate]);
  const hash = fingerprint(randomUUID());
  const keyId = await scalar(admin, `INSERT INTO purama_ai.iao_api_keys(project_id,key_hash,scopes,expires_at)
    VALUES($1,$2,$3,'2099-01-01') RETURNING id AS value`, [projectId, hash, allScopes]);
  return { projectId, keyId, hash };
}
const authorize = (client, key) => scalar(client, 'SELECT purama_ai.iao_api_authorize($1,$2,true) AS value', [key.hash, 'create']);
const bind = (client, key) => scalar(client, 'SELECT purama_ai.iao_api_bind_operation($1,$2,true,$3) AS value', [key.hash, external, 'create']);
const rpc = (client, key, method, args) => scalar(client, 'SELECT purama_ai.iao_api_consultation_call($1,$2,$3,$4::jsonb) AS value',
  [key.hash, external, method, JSON.stringify(args)]);
async function provision(cost = 100) {
  return scalar(admin, "SELECT purama_ai.model_consultation_provision($1,100000,$2,'2099-01-01',4) AS value", [owner, cost]);
}
async function begin(client, key, internal) {
  const value = request(internal);
  return rpc(client, key, 'create', { ...identity(internal), p_request_hash: fingerprint(value), p_request: value, p_plan: plan, p_estimates: estimates });
}
async function prepare() {
  const key = await credential(); await provision(); const internal = await bind(admin, key); const operation = await begin(admin, key, internal);
  assert.equal(await rpc(admin, key, 'start', { ...identity(internal), p_request_hash: fingerprint(request(internal)), p_generation: operation.generation }), true);
  return { key, internal, operation };
}
const reserve = (client, setup, number = 1) => rpc(client, setup.key, 'reserve', { ...identity(setup.internal), p_generation: setup.operation.generation,
  p_call: { userId: owner, operationId: setup.internal, callId: `native-call-${number}`, kind: 'synthesis', provider: 'anthropic',
    model: 'qualified-model', inputHash: 'a'.repeat(64), maxOutputTokens: 1024 } });
async function waitForBlocked(blocked) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const rows = (await admin.query('SELECT pid,wait_event_type FROM pg_stat_activity WHERE datname=$1 AND pid=ANY($2::integer[]) ORDER BY pid',
      [database, blocked.map(client => client.processID)])).rows;
    if (rows.length === blocked.length && rows.every(row => row.wait_event_type === 'Lock')) {
      console.log(JSON.stringify({ event: 'native_lock_wait_observed', backends: rows }));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Competing PostgreSQL backends must actually wait on a lock');
}

before(async () => {
  cluster = await connect('cluster', 'postgres');
  const settings = (await cluster.query(`SELECT current_database() AS database,current_user AS username,
    current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,
    current_setting('server_version_num')::int AS version,inet_server_addr() AS address,pg_is_in_recovery() AS recovery`)).rows[0];
  assert.equal(settings.database, 'postgres'); assert.equal(settings.username, connection.user); assert.equal(settings.data, expectedData);
  assert(settings.version >= 180000 && settings.version < 190000, 'Disposable PostgreSQL 18 required');
  assert.equal(settings.recovery, false);
  if (host.startsWith('/')) { assert.equal(settings.listen, ''); assert.equal(settings.address, null); }
  else { assert.equal(settings.listen, '127.0.0.1'); assert.equal(settings.address, '127.0.0.1'); }
  const roles = (await cluster.query(`SELECT rolname,rolsuper,rolcanlogin,rolcreaterole,rolcreatedb,rolbypassrls
    FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`, [['anon', 'authenticated', 'service_role']])).rows;
  assert.deepEqual(roles, ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname, rolsuper: false, rolcanlogin: false,
    rolcreaterole: false, rolcreatedb: false, rolbypassrls: rolname === 'service_role' })), 'Explicit fixture roles required');
  assert.equal((await cluster.query(`SELECT 1 FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))
    OR member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))`, [['anon', 'authenticated', 'service_role']])).rowCount, 0);
  console.log(JSON.stringify({ event: 'disposable_native_cluster_verified', ...settings, testDatabase: database }));
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
    '023_chef_process_quarantine.sql', '024_chef_claim_budget_reconciliation.sql',
    '030_chef_capability_selection.sql', '031_chef_workshop.sql', '032_model_consultation.sql', '039_iao_public_api.sql',
  ]) await admin.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
});
after(async () => {
  try {
    const results = await Promise.allSettled([...clients].filter(client => client !== cluster).map(close));
    if (created) {
      assert(/^purama_api_test_[0-9a-f]{32}$/.test(database));
      await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`); created = false;
      console.log(JSON.stringify({ event: 'disposable_test_database_removed', database }));
    }
    const failed = results.find(value => value.status === 'rejected'); if (failed) throw failed.reason;
  } finally { await close(cluster); }
});
beforeEach(async () => { await admin.query('TRUNCATE auth.users CASCADE'); await admin.query('INSERT INTO auth.users VALUES($1)', [owner]); });

test('concurrent keys consume exactly the last project rate slot', { timeout: 30000 }, async () => {
  const a = await credential({ rate: 1 }); const b = await credential({ projectId: a.projectId });
  const gate = await connect('rate_gate'), first = await service('rate_first'), second = await service('rate_second'); let calls = [];
  try {
    await gate.query('BEGIN'); await gate.query('SELECT id FROM purama_ai.iao_api_projects WHERE id=$1 FOR UPDATE', [a.projectId]);
    calls = [observe(authorize(first, a)), observe(authorize(second, b))]; await waitForBlocked([first, second]); await gate.query('COMMIT');
    const results = await Promise.all(calls);
    assert.equal(results.filter(value => value.ok).length, 1); assert.equal(results.find(value => !value.ok)?.code, 'PIA03');
    assert.equal(await scalar(admin, 'SELECT rate_count AS value FROM purama_ai.iao_api_projects WHERE id=$1', [a.projectId]), 1);
  } finally { await gate.query('ROLLBACK').catch(() => {}); await Promise.all(calls); await Promise.all([gate, first, second].map(close)); }
});

test('concurrent keys create one immutable external-to-internal binding', { timeout: 30000 }, async () => {
  const a = await credential(); const b = await credential({ projectId: a.projectId });
  const gate = await connect('bind_gate'), first = await service('bind_first'), second = await service('bind_second'); let calls = [];
  try {
    await gate.query('BEGIN'); await gate.query('SELECT id FROM purama_ai.iao_api_projects WHERE id=$1 FOR UPDATE', [a.projectId]);
    calls = [observe(bind(first, a)), observe(bind(second, b))]; await waitForBlocked([first, second]); await gate.query('COMMIT');
    const results = await Promise.all(calls); assert(results.every(value => value.ok)); assert.equal(results[0].value, results[1].value);
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.iao_api_operations'), 1);
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.chef_missions'), 0);
  } finally { await gate.query('ROLLBACK').catch(() => {}); await Promise.all(calls); await Promise.all([gate, first, second].map(close)); }
});

test('revocation commits before a waiting reserve and prevents provider admission', { timeout: 30000 }, async () => {
  const setup = await prepare(); const revoker = await service('revoke_first'), later = await service('reserve_later'); let pending;
  try {
    await revoker.query('BEGIN'); await revoker.query('UPDATE purama_ai.iao_api_keys SET revoked_at=clock_timestamp() WHERE id=$1', [setup.key.keyId]);
    pending = observe(reserve(later, setup)); await waitForBlocked([later]); await revoker.query('COMMIT');
    assert.deepEqual(await pending, { ok: false, code: 'PIA01' });
    assert.deepEqual(await observe(reserve(later, setup)), { ok: false, code: 'PIA01' });
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.model_consultation_calls'), 0);
  } finally { await revoker.query('ROLLBACK').catch(() => {}); if (pending) await pending; await Promise.all([revoker, later].map(close)); }
});

test('revocation waits behind an admitted reserve and rejects every later reserve', { timeout: 30000 }, async () => {
  const setup = await prepare(); const reserver = await service('reserve_first'), revoker = await service('revoke_later'); let pending;
  try {
    await reserver.query('BEGIN'); assert.equal(await reserve(reserver, setup), true);
    pending = observe(revoker.query('UPDATE purama_ai.iao_api_keys SET revoked_at=clock_timestamp() WHERE id=$1', [setup.key.keyId]));
    await waitForBlocked([revoker]); await reserver.query('COMMIT'); assert.equal((await pending).ok, true);
    assert.deepEqual(await observe(reserve(reserver, setup, 2)), { ok: false, code: 'PIA01' });
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.model_consultation_calls'), 1);
  } finally { await reserver.query('ROLLBACK').catch(() => {}); if (pending) await pending; await Promise.all([reserver, revoker].map(close)); }
});

test('separate projects cannot both reserve the final shared CHEF budget', { timeout: 30000 }, async () => {
  const mission = await provision(50); const a = await credential(); const b = await credential();
  const internalA = await bind(admin, a); const internalB = await bind(admin, b); assert.notEqual(internalA, internalB);
  const gate = await connect('budget_gate'), first = await service('budget_first'), second = await service('budget_second'); let calls = [];
  try {
    await gate.query('BEGIN'); await gate.query('SELECT id FROM purama_ai.chef_missions WHERE id=$1 FOR UPDATE', [mission]);
    calls = [observe(begin(first, a, internalA)), observe(begin(second, b, internalB))]; await waitForBlocked([first, second]); await gate.query('COMMIT');
    const results = await Promise.all(calls); assert.equal(results.filter(value => value.ok).length, 1); assert.equal(results.find(value => !value.ok)?.code, 'PCO02');
    assert.equal(await scalar(admin, 'SELECT sum(reserved_cost_micros)::int AS value FROM purama_ai.chef_budget_reservations'), 50);
    assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations'), 1);
  } finally { await gate.query('ROLLBACK').catch(() => {}); await Promise.all(calls); await Promise.all([gate, first, second].map(close)); }
});

for (const restriction of ['model', 'ceiling']) {
  test(`a committed project ${restriction} restriction stops a waiting provider reserve`, { timeout: 30000 }, async () => {
    const setup = await prepare(); const restrictor = await service(`${restriction}_first`), later = await service(`${restriction}_later`); let pending;
    try {
      await restrictor.query('BEGIN');
      await restrictor.query(restriction === 'model'
        ? "UPDATE purama_ai.iao_api_projects SET allowed_models=ARRAY['other-model'] WHERE id=$1"
        : 'UPDATE purama_ai.iao_api_projects SET max_operation_cost_micros=49 WHERE id=$1', [setup.key.projectId]);
      pending = observe(reserve(later, setup)); await waitForBlocked([later]); await restrictor.query('COMMIT');
      assert.deepEqual(await pending, { ok: false, code: restriction === 'model' ? 'PIA02' : 'PIA04' });
      assert.equal(await scalar(admin, 'SELECT count(*)::int AS value FROM purama_ai.model_consultation_calls'), 0);
    } finally { await restrictor.query('ROLLBACK').catch(() => {}); if (pending) await pending; await Promise.all([restrictor, later].map(close)); }
  });
}
