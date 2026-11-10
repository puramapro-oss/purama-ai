import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';

// Explicit endpoint and credentials, without DATABASE_URL/PGPASSWORD/pgpass:
// this suite needs a disposable,
// empty cluster. It never connects to an application's configured database.
const host = process.env.PURAMA_TRIAL_TEST_PG_HOST;
assert(host && (host === '127.0.0.1' || host.startsWith('/')), 'Explicit local test host required');
const expectedData = process.env.PURAMA_TRIAL_TEST_PG_DATA;
assert(expectedData, 'Explicit disposable cluster data directory required');
const connection = {
  host, port: Number(process.env.PURAMA_TRIAL_TEST_PG_PORT || 5432),
  user: process.env.PURAMA_TRIAL_TEST_PG_USER || 'postgres',
  password: () => process.env.PURAMA_TRIAL_TEST_PG_PASSWORD || '',
  ssl: false, options: '-c search_path=pg_catalog',
  database: 'postgres', connectionTimeoutMillis: 5000, statement_timeout: 12000,
};
const historical = readFileSync(new URL('../../supabase/migrations/20260727000000_subscriptions_security_and_trial.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261110043500_trial_admission_atomic.sql', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./fixtures/subscriptions.sql', import.meta.url), 'utf8');
const user = '00000000-0000-4000-8000-000000000001';
const gateId = 741927;
let admin;
let gate;
const clients = new Set();

async function connect(name) {
  const client = new pg.Client({ ...connection, application_name: `purama_trial_test_${name}` });
  await client.connect();
  clients.add(client);
  return client;
}

before(async () => {
  admin = await connect('admin');
  const settings = (await admin.query(`SELECT current_setting('data_directory') AS data,
    current_setting('listen_addresses') AS listen, inet_server_addr() AS address`)).rows[0];
  assert.equal(settings.data, expectedData, 'Refuse an unexpected server');
  if (host.startsWith('/')) {
    assert.equal(settings.listen, '', 'Private socket cluster must not listen on TCP');
    assert.equal(settings.address, null);
  }
  const existing = await admin.query(`SELECT 1 FROM pg_namespace WHERE nspname IN ('auth', 'purama_ai')
    UNION ALL SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`);
  assert.equal(existing.rowCount, 0, 'Refuse an initialized or shared Supabase cluster');
  await admin.query(fixture + historical);
  await admin.query('INSERT INTO auth.users VALUES ($1)', [user]);
  // A test-only barrier makes the race deterministic. Both old implementations
  // have completed their unlocked SELECT before either INSERT can proceed.
  await admin.query(`CREATE FUNCTION purama_ai.test_trial_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${gateId}); RETURN NEW; END; $$;
    CREATE TRIGGER test_trial_barrier BEFORE INSERT ON purama_ai.subscriptions
      FOR EACH ROW EXECUTE FUNCTION purama_ai.test_trial_barrier();`);
  gate = await connect('gate');
});

after(async () => {
  if (gate) await gate.query('ROLLBACK').catch(() => {});
  await Promise.all([...clients].map(client => client.end()));
});

beforeEach(async () => {
  await admin.query('TRUNCATE purama_ai.subscriptions');
  // Restore just the old function for explicit before/after counterexamples.
  const functionStart = historical.indexOf('CREATE OR REPLACE FUNCTION');
  await admin.query(historical.slice(functionStart));
});

async function pendingTrial(name, plan) {
  const client = await connect(name);
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
  await client.query('SET ROLE authenticated');
  // Attach the rejection handler immediately so a refused trial cannot become
  // an unhandled promise while the other transaction is still blocked.
  return { client, result: client.query('SELECT * FROM purama_ai.start_trial($1)', [plan])
    .then(value => ({ ok: true, row: value.rows[0] }), error => ({ ok: false, message: error.message })) };
}

async function waitForBlocked(count) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = await admin.query(`SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE application_name LIKE 'purama_trial_test_call_%' AND wait_event = 'advisory'`);
    if (result.rows[0].blocked === count) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} transactions at the INSERT barrier`);
}

async function race({ fixed, existing = false, paidStatus } = {}) {
  if (fixed) await admin.query(migration);
  if (existing || paidStatus) await admin.query(
    "INSERT INTO purama_ai.subscriptions (user_id, plan_type, status) VALUES ($1, 'free', 'canceled')", [user]);
  await gate.query('BEGIN');
  await gate.query('SELECT pg_advisory_xact_lock($1)', [gateId]);
  const calls = [];
  try {
    calls.push(await pendingTrial('call_one', 'starter'));
    if (!paidStatus) calls.push(await pendingTrial('call_two', 'ultime'));
    await waitForBlocked(calls.length);
    if (paidStatus) await admin.query(
      "UPDATE purama_ai.subscriptions SET plan_type='pro', status=$1, stripe_customer_id='cus_paid_fixture' WHERE user_id=$2", [paidStatus, user]);
    await gate.query('COMMIT');
    const outcomes = await Promise.all(calls.map(call => call.result));
    const rows = (await admin.query('SELECT * FROM purama_ai.subscriptions')).rows;
    return { outcomes, rows };
  } finally {
    await gate.query('ROLLBACK');
    await Promise.all(calls.map(async call => { await call.result; await call.client.end(); clients.delete(call.client); }));
  }
}

test('historical function permits two concurrent first trials', async () => {
  const { outcomes, rows } = await race();
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 2);
  assert.equal(rows.length, 1, 'Uniqueness alone does not protect admission');
});

test('historical function overwrites a paid subscription committed after its read', async () => {
  const { outcomes, rows } = await race({ paidStatus: 'active' });
  assert.equal(outcomes[0].ok, true);
  assert.equal(rows[0].status, 'trialing');
  assert.equal(rows[0].plan_type, 'starter');
});

for (const existing of [false, true]) {
  test(`atomic admission has one winner with existing row=${existing}`, async () => {
    const { outcomes, rows } = await race({ fixed: true, existing });
    const winners = outcomes.filter(outcome => outcome.ok);
    const losers = outcomes.filter(outcome => !outcome.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(losers[0].message, /Essai déjà/);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].plan_type, winners[0].row.plan_type);
    assert.deepEqual(rows[0].trial_ends_at, winners[0].row.trial_ends_at);
    assert.equal(rows[0].has_used_trial, true);
  });
}

for (const status of ['active', 'trialing']) {
  test(`atomic admission preserves a concurrent provider status=${status}`, async () => {
    const { outcomes, rows } = await race({ fixed: true, paidStatus: status });
    assert.equal(outcomes[0].ok, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, status);
    assert.equal(rows[0].plan_type, 'pro');
    assert.equal(rows[0].stripe_customer_id, 'cus_paid_fixture');
    assert.equal(rows[0].has_used_trial, false);
    assert.equal(rows[0].trial_ends_at, null);
  });
}
