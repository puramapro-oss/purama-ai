import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Reuse consultationStore.native's explicit PostgreSQL 18 fixture. This file
// creates only its own database; the existing CI service owns the cluster.
// No application connection settings, existing Supabase database or provider.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = join(repo, 'qa/partner-discovery-20261124/native/runtime-report.json');
const suffix = randomUUID().replaceAll('-', '');
const database = `purama_partner_discovery_test_${suffix}`;
const applicationPrefix = `partner_discovery_${suffix.slice(0, 8)}_`;
const owner = '00000000-0000-4000-8000-000000004001';
const other = '00000000-0000-4000-8000-000000004002';
const sourcePaths = [
  'supabase/migrations/20260406230000_partner_agent.sql',
  'supabase/migrations/20261124050000_partner_discovery_evidence.sql',
  'karta/test/partnerDiscoverySql.test.ts',
];
const sources = new Map();
const clients = new Set();
const sessions = new Map();
const expectedChecks = 8;
const report = {
  status: 'RUNNING', started_at: new Date().toISOString(), node_version: process.version,
  ci_commit: process.env.GITHUB_SHA ?? null,
  scope: 'Actual discovery migrations, independent PostgreSQL sessions, observed blockers and READ COMMITTED transactions',
  isolation: {
    existing_ci_fixture_only: true, application_database_used: false,
    database, provider_calls: 0, cluster_lifecycle: 'Existing CI service; this suite never starts or stops it',
  },
  sources: [], sessions: [], checks: [], setup_received: false, connection_errors: [],
  cleanup: { errors: [], database_created: false, database_removed: false, connections_remaining: null, backend_sessions_remaining: null },
};
let connection, cluster, admin, created = false;
let setupPhase = 'fixture_guard';
const hash = value => createHash('sha256').update(value).digest('hex');
const errorRecord = error => ({ message: String(error.message), code: error.code ?? null });
const observe = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, ...errorRecord(error) }));

async function connect(label, target = database, role = null) {
  assert(connection, 'Fixture connection must be validated first');
  assert(role === null || ['anon', 'authenticated', 'service_role'].includes(role));
  const client = new pg.Client({ ...connection, database: target, application_name: applicationPrefix + label });
  clients.add(client);
  const session = { label, database: target, role, pid: null, connected: false, closed: false };
  sessions.set(client, session);
  report.sessions.push(session);
  client.on('error', error => report.connection_errors.push({ label, ...errorRecord(error) }));
  await client.connect();
  assert(Number.isInteger(client.processID));
  session.pid = client.processID;
  session.connected = true;
  if (role) await client.query(`SET ROLE ${role}`);
  const identity = (await client.query("SELECT current_database() AS database,current_user AS username,current_setting('transaction_isolation') AS isolation")).rows[0];
  assert.equal(identity.database, target);
  assert.equal(identity.username, role ?? connection.user);
  assert.equal(identity.isolation, 'read committed');
  session.default_isolation = identity.isolation;
  return client;
}
async function close(client) {
  if (!client || !clients.has(client)) return;
  try {
    await client.end();
    clients.delete(client);
    sessions.get(client).closed = true;
  } catch (error) {
    report.cleanup.errors.push({ stage: 'client_end', label: sessions.get(client)?.label, ...errorRecord(error) });
  }
}
async function service(label) { return connect(label, database, 'service_role'); }
async function scalar(client, sql, values = []) { return (await client.query(sql, values)).rows[0].value; }
async function begin(client) {
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL lock_timeout='6s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='15s'");
  assert.equal(await scalar(client, "SELECT current_setting('transaction_isolation') AS value"), 'read committed');
}
function candidate(email = 'regie@journal.example', note = 'first') {
  const normalized = email === null ? null : email.trim().toLowerCase();
  return {
    name: 'Journal', email, website: 'https://journal.example/', type: 'media', contact_role: 'commercial',
    ai_score: 75, followers_count: null, social_links: {},
    contact_evidence: normalized === null ? {} : {
      source_url: 'https://journal.example/contact', observed_at: '2026-11-24T12:00:00Z',
      verification: 'observed_in_search_result', email: normalized,
      excerpt: `Contact commercial : ${normalized}`, fixture_note: note,
    },
  };
}
async function importRows(client, rows, user = owner) {
  return scalar(client, 'SELECT purama_ai.partner_discovery_import($1,$2::jsonb) AS value', [user, JSON.stringify(rows)]);
}
async function persisted() {
  const rows = (await admin.query('SELECT id,user_id,name,email,website,contact_role,contact_evidence,status,found_by_ai,source FROM purama_ai.partner_prospects ORDER BY user_id,email NULLS LAST,id')).rows;
  const counters = (await admin.query('SELECT user_id,total_prospects_found FROM purama_ai.partner_agent_config ORDER BY user_id')).rows;
  return { rows, counters: Object.fromEntries(counters.map(row => [row.user_id, row.total_prospects_found])) };
}
function assertReceipt(value, inserted, skipped) {
  assert.equal(value.inserted, inserted);
  assert.equal(value.skipped, skipped);
  assert.equal(value.prospects.length, inserted);
}
function assertImported(row, user = owner) {
  assert.equal(row.user_id, user);
  assert.equal(row.status, 'identified');
  assert.equal(row.found_by_ai, true);
  assert.equal(row.source, 'ai_search');
}
async function waitForBlocked(blocked, blocker, event = 'advisory') {
  assert.notEqual(blocked.processID, blocker.processID);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (await admin.query(`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE datname=$1 AND pid=$2`, [database, blocked.processID])).rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event === event && row.blockers.includes(blocker.processID)) {
      return { ...row, expected_blocker: blocker.processID, observed_at: new Date().toISOString() };
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`PID ${blocked.processID} must actually wait on ${event} held by PID ${blocker.processID}`);
}
async function heldRace(firstOperation, secondOperation, { final = 'COMMIT', firstRole = 'service_role', event = 'advisory' } = {}) {
  assert(['COMMIT', 'ROLLBACK'].includes(final));
  const first = await connect('race_first', database, firstRole);
  const second = await service('race_second');
  let pending;
  try {
    await begin(first);
    const firstResult = await firstOperation(first);
    await begin(second);
    pending = observe(secondOperation(second));
    const lock = await waitForBlocked(second, first, event);
    await first.query(final);
    const secondResult = await pending;
    assert.equal(secondResult.ok, true, JSON.stringify(secondResult));
    await second.query('COMMIT');
    return { first: firstResult, second: secondResult.value, first_transaction: final, lock };
  } finally {
    await first.query('ROLLBACK').catch(() => {});
    if (pending) await pending;
    await second.query('ROLLBACK').catch(() => {});
    await Promise.all([first, second].map(close));
  }
}
function check(name, body) {
  test(name, { timeout: 30000, concurrency: false }, async () => {
    const at = Date.now();
    try {
      const details = await body();
      report.checks.push({ name, status: 'PASS', duration_ms: Date.now() - at, details });
    } catch (error) {
      report.checks.push({ name, status: 'FAIL', duration_ms: Date.now() - at, ...errorRecord(error) });
      throw error;
    }
  });
}

before(async () => {
  try {
    const host = process.env.PURAMA_TRIAL_TEST_PG_HOST;
    const expectedData = process.env.PURAMA_TRIAL_TEST_PG_DATA;
    const port = Number(process.env.PURAMA_TRIAL_TEST_PG_PORT || 5432);
    assert(host && (host === '127.0.0.1' || host.startsWith('/')), 'Explicit local fixture host required');
    assert(expectedData, 'Explicit disposable fixture data directory required');
    assert(Number.isInteger(port) && port > 0 && port <= 65535);
    assert(/^purama_partner_discovery_test_[0-9a-f]{32}$/.test(database));
    connection = {
      host, port, user: process.env.PURAMA_TRIAL_TEST_PG_USER || 'postgres',
      password: () => process.env.PURAMA_TRIAL_TEST_PG_PASSWORD || '', ssl: false,
      options: '-c search_path=pg_catalog', connectionTimeoutMillis: 5000, statement_timeout: 12000,
    };
    for (const path of sourcePaths) {
      const bytes = await readFile(join(repo, path));
      sources.set(path, bytes);
      report.sources.push({ path, sha256: hash(bytes) });
    }
    report.harness_sha256 = hash(await readFile(fileURLToPath(import.meta.url)));
    cluster = await connect('cluster', 'postgres');
    const settings = (await cluster.query(`SELECT current_database() AS database,current_user AS username,
      current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,
      current_setting('server_version_num')::int AS version,version() AS full_version,inet_server_addr() AS address`)).rows[0];
    assert.equal(settings.database, 'postgres');
    assert.equal(settings.username, connection.user);
    assert.equal(settings.data, expectedData, 'Refuse a different PostgreSQL cluster');
    assert(settings.version >= 180000 && settings.version < 190000, 'Disposable PostgreSQL 18 required');
    if (host.startsWith('/')) {
      assert.equal(settings.listen, '');
      assert.equal(settings.address, null);
    }
    // A loopback client endpoint can be forwarded to the CI container's own IP.
    // As in consultationStore.native, identify that TCP fixture by its exact
    // data directory and PostgreSQL version, not by inet_server_addr().
    const roles = (await cluster.query('SELECT rolname,rolsuper,rolcanlogin,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname', [['anon', 'authenticated', 'service_role']])).rows;
    assert.deepEqual(roles, ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname, rolsuper: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: rolname === 'service_role' })), 'Use only roles already created by the existing subscription fixture');
    assert.equal((await cluster.query('SELECT 1 FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) OR member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))', [['anon', 'authenticated', 'service_role']])).rowCount, 0);
    report.isolation.fixture_identity = settings;
    report.isolation.fixture_roles = roles;
    await cluster.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    report.cleanup.database_created = true;
    setupPhase = 'migrations';
    admin = await connect('admin');
    assert.equal((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','purama_ai')")).rowCount, 0);
    await admin.query(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
    for (const path of sourcePaths.filter(path => path.endsWith('.sql'))) {
      await admin.query(sources.get(path).toString('utf8'));
    }
    report.setup_received = true;
  } catch (error) {
    report.status = setupPhase === 'fixture_guard' ? 'BLOQUE' : 'FAIL';
    report.setup_error = { phase: setupPhase, ...errorRecord(error) };
    throw error;
  }
});

beforeEach(async () => {
  await admin.query('TRUNCATE auth.users CASCADE');
  await admin.query('INSERT INTO auth.users(id) VALUES($1),($2)', [owner, other]);
  await admin.query('INSERT INTO purama_ai.partner_agent_config(user_id) VALUES($1),($2)', [owner, other]);
});

after(async () => {
  try {
    await Promise.all([...clients].filter(client => client !== cluster).map(close));
    if (created) {
      assert(/^purama_partner_discovery_test_[0-9a-f]{32}$/.test(database));
      const beforeDrop = await scalar(cluster, 'SELECT count(*)::int AS value FROM pg_stat_activity WHERE datname=$1', [database]);
      report.cleanup.backend_sessions_before_drop = beforeDrop;
      await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      created = false;
      report.cleanup.database_removed = (await cluster.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount === 0;
      report.cleanup.backend_sessions_remaining = await scalar(cluster, 'SELECT count(*)::int AS value FROM pg_stat_activity WHERE datname=$1', [database]);
      assert.equal(beforeDrop, 0, 'All fixture connections must close before dropping the database');
      assert.equal(report.cleanup.backend_sessions_remaining, 0);
      assert.equal(report.cleanup.database_removed, true);
    }
    for (const source of report.sources) {
      assert.equal(hash(await readFile(join(repo, source.path))), source.sha256, `Source changed during run: ${source.path}`);
    }
    report.sources_unchanged_after = true;
  } catch (error) {
    report.cleanup.errors.push({ stage: 'database_cleanup_or_source_check', ...errorRecord(error) });
  } finally {
    await Promise.all([...clients].map(close));
    report.cleanup.connections_remaining = clients.size;
    const received = report.setup_received && report.checks.length === expectedChecks && report.checks.every(value => value.status === 'PASS');
    const clean = report.cleanup.database_removed && report.cleanup.backend_sessions_remaining === 0 && clients.size === 0 && report.cleanup.errors.length === 0 && report.connection_errors.length === 0;
    if (received && clean && report.sources_unchanged_after) report.status = 'PASS';
    else if (report.status !== 'BLOQUE') report.status = 'FAIL';
    report.finished_at = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanup: report.cleanup, output }));
  }
  assert.equal(report.status, 'PASS', 'Native discovery reception and cleanup must both pass');
});

check('two real sessions import one normalized email and preserve the first evidence', async () => {
  const first = { ...candidate(' REGIE@JOURNAL.EXAMPLE ', 'first'), status: 'ready_to_contact', found_by_ai: false };
  const race = await heldRace(client => importRows(client, [first]), client => importRows(client, [candidate(undefined, 'later')]));
  assertReceipt(race.first, 1, 0);
  assertReceipt(race.second, 0, 1);
  const state = await persisted();
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].email, 'regie@journal.example');
  assert.deepEqual(state.rows[0].contact_evidence, first.contact_evidence);
  assertImported(state.rows[0]);
  assert.deepEqual(state.counters, { [owner]: 1, [other]: 0 });
  return { ...race, state };
});

check('two real sessions deduplicate an addressless organization without a unique email key', async () => {
  const race = await heldRace(client => importRows(client, [candidate(null)]), client => importRows(client, [{ ...candidate(null), name: ' JOURNAL ' }]));
  assertReceipt(race.first, 1, 0);
  assertReceipt(race.second, 0, 1);
  const state = await persisted();
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].email, null);
  assert.equal(state.rows[0].name, 'Journal');
  assertImported(state.rows[0]);
  assert.deepEqual(state.counters, { [owner]: 1, [other]: 0 });
  return { ...race, state };
});

check('two distinct emails for one owner retain both counter increments', async () => {
  const race = await heldRace(client => importRows(client, [candidate()]), client => importRows(client, [candidate('redaction@journal.example')]));
  assertReceipt(race.first, 1, 0);
  assertReceipt(race.second, 1, 0);
  const state = await persisted();
  assert.equal(state.rows.length, 2);
  assert.equal(new Set(state.rows.map(row => row.id)).size, 2);
  state.rows.forEach(row => assertImported(row));
  assert.deepEqual(state.counters, { [owner]: 2, [other]: 0 });
  return { ...race, state };
});

check('a different owner completes before the first owner releases its transaction', async () => {
  const first = await service('owner_first'), second = await service('owner_other');
  try {
    assert.notEqual(first.processID, second.processID);
    await begin(first);
    const firstResult = await importRows(first, [candidate()], owner);
    await begin(second);
    const secondResult = await importRows(second, [candidate()], other);
    await second.query('COMMIT');
    // The first transaction is still open. Its row and counter are not visible.
    const beforeFirstCommit = await persisted();
    assert.equal(beforeFirstCommit.rows.length, 1);
    assertImported(beforeFirstCommit.rows[0], other);
    assert.deepEqual(beforeFirstCommit.counters, { [owner]: 0, [other]: 1 });
    await first.query('COMMIT');
    assertReceipt(firstResult, 1, 0);
    assertReceipt(secondResult, 1, 0);
    const state = await persisted();
    assert.equal(state.rows.length, 2);
    assert.deepEqual(state.counters, { [owner]: 1, [other]: 1 });
    return { first_pid: first.processID, second_pid: second.processID, before_first_commit: beforeFirstCommit, state };
  } finally {
    await first.query('ROLLBACK').catch(() => {});
    await second.query('ROLLBACK').catch(() => {});
    await Promise.all([first, second].map(close));
  }
});

check('rollback of the first import lets its waiting successor create the only row', async () => {
  const retained = candidate(undefined, 'successor');
  const race = await heldRace(client => importRows(client, [candidate(undefined, 'rolled-back')]), client => importRows(client, [retained]), { final: 'ROLLBACK' });
  assertReceipt(race.first, 1, 0);
  assertReceipt(race.second, 1, 0);
  const state = await persisted();
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].id, race.second.prospects[0].id);
  assert.notEqual(state.rows[0].id, race.first.prospects[0].id);
  assert.deepEqual(state.rows[0].contact_evidence, retained.contact_evidence);
  assert.deepEqual(state.counters, { [owner]: 1, [other]: 0 });
  return { ...race, state };
});

check('an invalid batch rolls back completely and releases its waiting successor', async () => {
  const first = await service('invalid_first'), second = await service('invalid_waiter');
  let pending;
  try {
    await begin(first);
    await first.query("SELECT pg_advisory_xact_lock(hashtextextended('partner-discovery:'||$1::text,0))", [owner]);
    await begin(second);
    const retained = candidate(undefined, 'valid-successor');
    pending = observe(importRows(second, [retained]));
    const lock = await waitForBlocked(second, first);
    const invalid = { ...candidate('invalid@journal.example'), contact_evidence: {} };
    const rejected = await observe(importRows(first, [candidate('rollback@journal.example'), invalid]));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, '22023');
    assert.match(rejected.message, /discovery_email_evidence_required/);
    await first.query('ROLLBACK');
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result));
    assertReceipt(result.value, 1, 0);
    await second.query('COMMIT');
    const state = await persisted();
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].email, retained.email);
    assert.deepEqual(state.rows[0].contact_evidence, retained.contact_evidence);
    assert.deepEqual(state.counters, { [owner]: 1, [other]: 0 });
    return { rejected, lock, successor: result.value, state };
  } finally {
    await first.query('ROLLBACK').catch(() => {});
    if (pending) await pending;
    await second.query('ROLLBACK').catch(() => {});
    await Promise.all([first, second].map(close));
  }
});

check('an ordinary exact-email insert wins without being rewritten or counted by discovery', async () => {
  const race = await heldRace(async client => {
    return (await client.query(`INSERT INTO purama_ai.partner_prospects(user_id,name,email,status,source,found_by_ai)
      VALUES($1,'Manual retained','regie@journal.example','rejected','manual',false) RETURNING id`, [owner])).rows[0];
  }, client => importRows(client, [candidate()]), { firstRole: null, event: 'transactionid' });
  assertReceipt(race.second, 0, 1);
  const state = await persisted();
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].id, race.first.id);
  assert.equal(state.rows[0].name, 'Manual retained');
  assert.equal(state.rows[0].status, 'rejected');
  assert.equal(state.rows[0].source, 'manual');
  assert.equal(state.rows[0].found_by_ai, false);
  assert.deepEqual(state.rows[0].contact_evidence, {});
  assert.deepEqual(state.counters, { [owner]: 0, [other]: 0 });
  return { ...race, state, limit: 'Exact-email key only; no claim to serialize all manual writes' };
});

check('only the service role can invoke discovery on the native server', async () => {
  const attempts = [];
  for (const role of ['anon', 'authenticated']) {
    const client = await connect(`denied_${role}`, database, role);
    try {
      const allowed = await scalar(admin, "SELECT has_function_privilege($1,'purama_ai.partner_discovery_import(uuid,jsonb)','EXECUTE') AS value", [role]);
      assert.equal(allowed, false);
      const result = await observe(importRows(client, [candidate()], other));
      assert.equal(result.ok, false);
      assert.equal(result.code, '42501');
      attempts.push({ role, ...result });
    } finally { await close(client); }
  }
  assert.deepEqual((await persisted()).counters, { [owner]: 0, [other]: 0 });
  const allowed = await scalar(admin, "SELECT has_function_privilege('service_role','purama_ai.partner_discovery_import(uuid,jsonb)','EXECUTE') AS value");
  assert.equal(allowed, true);
  const client = await service('allowed');
  try {
    const value = await importRows(client, [candidate()]);
    assertReceipt(value, 1, 0);
    const state = await persisted();
    assert.equal(state.rows.length, 1);
    assertImported(state.rows[0]);
    assert.deepEqual(state.counters, { [owner]: 1, [other]: 0 });
    return { attempts, service: value, state };
  } finally { await close(client); }
});
