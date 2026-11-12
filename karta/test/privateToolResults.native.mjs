import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';

// Reuse the explicit, local, disposable-cluster gate of subscriptionTrial.native.
// Never use DATABASE_URL, PGDATABASE, PGPASSWORD or an application database.
const host = process.env.PURAMA_TRIAL_TEST_PG_HOST;
assert(host && (host === '127.0.0.1' || host.startsWith('/')), 'Explicit local test host required');
const expectedData = process.env.PURAMA_TRIAL_TEST_PG_DATA;
assert(expectedData, 'Explicit disposable cluster data directory required');
const port = Number(process.env.PURAMA_TRIAL_TEST_PG_PORT || 5432);
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Valid explicit local test port required');
const connection = {
  host, port, user: process.env.PURAMA_TRIAL_TEST_PG_USER || 'postgres',
  password: () => process.env.PURAMA_TRIAL_TEST_PG_PASSWORD || '',
  ssl: false, options: '-c search_path=pg_catalog', database: 'postgres',
  connectionTimeoutMillis: 5000, statement_timeout: 12000,
};
const suffix = randomUUID().replaceAll('-', '');
const database = `purama_private_results_test_${suffix}`;
assert(/^purama_private_results_test_[0-9a-f]{32}$/.test(database));
const owner = '00000000-0000-4000-8000-000000000421';
const otherOwner = '00000000-0000-4000-8000-000000000422';
const agent = '00000000-0000-4000-8000-000000000423';
const agentType = `custom:${agent}`;
const clients = new Set();
let cluster;
let admin;
let created = false;

const data = {
  schema_version: 1, tool_name: 'quantum_simulate', status: 'complete',
  summary: 'Fixture de simulation locale classique ; aucun QPU ni avantage quantique démontré.', sources: [],
  details: {
    execution_kind: 'local_simulator', backend_kind: 'classical_statevector',
    physical_quantum_hardware: false, quantum_advantage_demonstrated: false, external_api_calls: 0,
    qubits: 1, gate_count: 1, shots: 0, seed: 0, probabilities: [0.5, 0.5], counts: {},
    state_norm_squared: 1, input_sha256: '0'.repeat(64),
    provenance: {
      implementation: 'purama-karta-statevector', implementation_version: '1', arithmetic: 'float64_complex',
      initial_state: 'all_zero', bit_order: 'q0_least_significant', measurement: 'final_computational_basis',
      sampling: 'mulberry32_noncryptographic', input_hash_format: 'sha256_canonical_validated_json_v1',
      limits: { max_qubits: 10, max_gates: 128, max_shots: 8192, max_abs_angle_radians: 1000000 },
    },
  },
};

async function connect(name, target = database) {
  const client = new pg.Client({ ...connection, database: target,
    application_name: `purama_private_${suffix.slice(0, 8)}_${name}` });
  await client.connect();
  clients.add(client);
  assert(Number.isInteger(client.processID), 'A PostgreSQL backend PID is required for observed lock barriers');
  return client;
}

async function close(client) {
  if (!client || !clients.has(client)) return;
  try { await client.end(); } finally { clients.delete(client); }
}

before(async () => {
  cluster = await connect('cluster', 'postgres');
  const settings = (await cluster.query(`SELECT current_database() AS database, current_user AS username,
    current_setting('data_directory') AS data, current_setting('listen_addresses') AS listen,
    current_setting('server_version_num')::integer AS version, inet_server_addr() AS address`)).rows[0];
  assert.equal(settings.database, 'postgres');
  assert.equal(settings.username, connection.user);
  assert.equal(settings.data, expectedData, 'Refuse an unexpected server');
  assert(settings.version >= 180000 && settings.version < 190000, 'This qualification requires the disposable PostgreSQL 18 CI cluster');
  if (host.startsWith('/')) {
    assert.equal(settings.listen, '', 'Private socket cluster must not listen on TCP');
    assert.equal(settings.address, null);
  }

  // The earlier subscription qualification owns these global roles. Do not
  // create, alter, grant membership in, or delete them in this suite.
  const roles = (await cluster.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,
    rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig
    FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [['anon', 'authenticated', 'service_role']])).rows;
  assert.deepEqual(roles, ['anon', 'authenticated', 'service_role'].map(rolname => ({
    rolname, rolsuper: false, rolinherit: true, rolcreaterole: false, rolcreatedb: false,
    rolcanlogin: false, rolreplication: false, rolbypassrls: rolname === 'service_role',
    rolconnlimit: -1, rolvaliduntil: null, rolconfig: null,
  })), 'Refuse missing or unexpectedly privileged fixture roles');
  const membership = await cluster.query(`SELECT 1 FROM pg_auth_members m
    WHERE m.roleid IN (SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[]))
       OR m.member IN (SELECT oid FROM pg_roles WHERE rolname = ANY($1::text[]))`, [['anon', 'authenticated', 'service_role']]);
  assert.equal(membership.rowCount, 0, 'Refuse unexpected role inheritance in the fixture cluster');

  // Only this freshly generated name is ever created or dropped. Existing auth
  // and purama_ai schemas in postgres, from the trial suite, are not touched.
  await cluster.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  created = true;
  admin = await connect('admin');
  const existing = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','purama_ai')");
  assert.equal(existing.rowCount, 0, 'The new disposable database must be empty');
  await admin.query(`
    CREATE SCHEMA auth;
    CREATE SCHEMA purama_ai;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    GRANT USAGE ON SCHEMA auth,purama_ai TO anon,authenticated,service_role;
    CREATE TABLE purama_ai.creator_agents (
      id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
      is_active boolean DEFAULT true, karta_enabled boolean DEFAULT true, tools_enabled text[] DEFAULT '{}'
    );
    ALTER TABLE purama_ai.creator_agents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_read ON purama_ai.creator_agents FOR SELECT TO authenticated USING(user_id = auth.uid());
  `);
  for (const filename of ['001_karta_core.sql', '005_karta_pending_actions.sql']) {
    await admin.query(readFileSync(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'));
  }
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role; GRANT SELECT ON ALL TABLES IN SCHEMA purama_ai TO authenticated;');
  await admin.query(readFileSync(new URL('../migrations/028_private_tool_results.sql', import.meta.url), 'utf8'));
});

after(async () => {
  try {
    // Every race rolls back its blocking transaction in finally. Close all
    // remaining target connections before dropping only our created database.
    const results = await Promise.allSettled([...clients].filter(client => client !== cluster).map(close));
    if (created) {
      assert(/^purama_private_results_test_[0-9a-f]{32}$/.test(database));
      await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      created = false;
    }
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  } finally { await close(cluster); }
});

beforeEach(async () => {
  await admin.query('TRUNCATE auth.users CASCADE');
  await admin.query('INSERT INTO auth.users(id) VALUES($1),($2)', [owner, otherOwner]);
  await admin.query("INSERT INTO purama_ai.creator_agents(id,user_id,tools_enabled) VALUES($1,$2,ARRAY['knowledge_search','quantum_simulate'])", [agent, owner]);
});

async function run({ status = 'running', duration = null } = {}) {
  const id = randomUUID();
  await admin.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms) VALUES($1,$2,$3,'manual','live',$4,$5)", [id, owner, agentType, status, duration]);
  return id;
}

async function rpc(client, runId, { payload = data, operation = `${runId}:0` } = {}) {
  return (await client.query('SELECT purama_ai.karta_store_tool_result($1,$2,$3,$4,$5,$6::jsonb) AS id',
    [owner, agentType, runId, operation, 'quantum_simulate', JSON.stringify(payload)])).rows[0].id;
}

// Consume rejection immediately; a deliberately blocked losing RPC must not
// become an unhandled rejection while the winning transaction is still open.
const settle = promise => promise.then(id => ({ ok: true, id }), error => ({ ok: false, message: error.message, code: error.code }));
const refused = outcome => assert.deepEqual(outcome, { ok: false, message: 'Private result unavailable', code: 'P0001' });
const rows = async () => (await admin.query('SELECT id,payload FROM purama_ai.karta_tool_results')).rows;

async function service(name) {
  const client = await connect(name);
  await client.query('SET ROLE service_role');
  return client;
}

async function waitForBlocked(blockedClients) {
  const pids = blockedClients.map(client => client.processID);
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const observed = (await admin.query(`SELECT pid,wait_event_type FROM pg_stat_activity
      WHERE datname=$1 AND pid = ANY($2::integer[])`, [database, pids])).rows;
    if (observed.length === pids.length && observed.every(row => row.wait_event_type === 'Lock')) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Expected ${pids.length} test backend(s) to actually wait for a PostgreSQL lock`);
}

test('two identical RPCs waiting on the parent return one durable result identity', { timeout: 30000 }, async () => {
  const runId = await run();
  const gate = await connect('identical_gate');
  const first = await service('identical_first');
  const second = await service('identical_second');
  let calls = [];
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT id FROM purama_ai.karta_runs WHERE id=$1 FOR UPDATE', [runId]);
    calls = [settle(rpc(first, runId)), settle(rpc(second, runId, { payload: Object.fromEntries(Object.entries(data).reverse()) }))];
    await waitForBlocked([first, second]);
    await gate.query('COMMIT');
    const outcomes = await Promise.all(calls);
    assert(outcomes.every(outcome => outcome.ok), 'Both identical deliveries must reconcile successfully');
    assert.equal(outcomes[0].id, outcomes[1].id);
    assert.deepEqual(await rows(), [{ id: outcomes[0].id, payload: data }]);
  } finally {
    await gate.query('ROLLBACK').catch(() => {});
    await Promise.all(calls);
    await Promise.all([first, second, gate].map(close));
  }
});

test('a divergent RPC waits for the first result then refuses to replace it', { timeout: 30000 }, async () => {
  const runId = await run();
  const first = await service('divergent_first');
  const second = await service('divergent_second');
  let late;
  try {
    await first.query('BEGIN');
    const id = await rpc(first, runId);
    late = settle(rpc(second, runId, { payload: { ...data, summary: 'Different immutable result' } }));
    await waitForBlocked([second]);
    await first.query('COMMIT');
    refused(await late);
    assert.deepEqual(await rows(), [{ id, payload: data }]);
  } finally {
    await first.query('ROLLBACK').catch(() => {});
    if (late) await late;
    await Promise.all([first, second].map(close));
  }
});

test('parent closure committed while an insert waits prevents a late new result', { timeout: 30000 }, async () => {
  const runId = await run();
  const gate = await connect('close_parent');
  const caller = await service('closed_caller');
  let late;
  try {
    await gate.query('BEGIN');
    await gate.query("UPDATE purama_ai.karta_runs SET status='success',duration_ms=1,finished_at=now() WHERE id=$1", [runId]);
    late = settle(rpc(caller, runId));
    await waitForBlocked([caller]);
    await gate.query('COMMIT');
    refused(await late);
    assert.deepEqual(await rows(), []);
  } finally {
    await gate.query('ROLLBACK').catch(() => {});
    if (late) await late;
    await Promise.all([caller, gate].map(close));
  }
});

test('owner deletion of a closed result blocks reconciliation then permanently removes it', { timeout: 30000 }, async () => {
  const runId = await run();
  const id = await rpc(admin, runId);
  await admin.query("UPDATE purama_ai.karta_runs SET status='success',duration_ms=1,finished_at=now() WHERE id=$1", [runId]);
  const deleter = await connect('owner_delete');
  const caller = await service('deleted_caller');
  let late;
  try {
    await deleter.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await deleter.query('SET ROLE authenticated');
    await deleter.query('BEGIN');
    assert.equal((await deleter.query('DELETE FROM purama_ai.karta_tool_results WHERE id=$1 RETURNING id', [id])).rowCount, 1);
    late = settle(rpc(caller, runId));
    await waitForBlocked([caller]);
    await deleter.query('COMMIT');
    refused(await late);
    assert.deepEqual(await rows(), []);
    // Reconciliation must also refuse on a fresh snapshot after that race.
    refused(await settle(rpc(caller, runId)));
  } finally {
    await deleter.query('ROLLBACK').catch(() => {});
    if (late) await late;
    await Promise.all([caller, deleter].map(close));
  }
});

test('agent transfer committed before insertion is rechecked after the ownership lock', { timeout: 30000 }, async () => {
  const runId = await run();
  const gate = await connect('transfer_agent');
  const caller = await service('transferred_caller');
  let late;
  try {
    await gate.query('BEGIN');
    await gate.query('UPDATE purama_ai.creator_agents SET user_id=$1 WHERE id=$2', [otherOwner, agent]);
    late = settle(rpc(caller, runId));
    await waitForBlocked([caller]);
    await gate.query('COMMIT');
    refused(await late);
    assert.deepEqual(await rows(), []);
    assert.equal((await admin.query('SELECT user_id FROM purama_ai.creator_agents WHERE id=$1', [agent])).rows[0].user_id, otherOwner);
  } finally {
    await gate.query('ROLLBACK').catch(() => {});
    if (late) await late;
    await Promise.all([caller, gate].map(close));
  }
});

test('approved-action completion committed before a late insert is rechecked after waiting', { timeout: 30000 }, async () => {
  const runId = await run({ status: 'awaiting_approval', duration: 1 });
  const operation = randomUUID();
  await admin.query("INSERT INTO purama_ai.karta_pending_actions(id,user_id,agent_type,run_id,tool_name,tool_params,status) VALUES($1,$2,$3,$4,'quantum_simulate','{}','executing')", [operation, owner, agentType, runId]);
  const gate = await connect('finish_pending');
  const caller = await service('finished_caller');
  let late;
  try {
    await gate.query('BEGIN');
    // Model the committed authoritative state transition, without importing the
    // unrelated queue/continuation machinery into this migration qualification.
    await gate.query("UPDATE purama_ai.karta_pending_actions SET status='executed',resolved_at=now() WHERE id=$1", [operation]);
    late = settle(rpc(caller, runId, { operation }));
    await waitForBlocked([caller]);
    await gate.query('COMMIT');
    refused(await late);
    assert.deepEqual(await rows(), []);
  } finally {
    await gate.query('ROLLBACK').catch(() => {});
    if (late) await late;
    await Promise.all([caller, gate].map(close));
  }
});
