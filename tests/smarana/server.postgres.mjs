import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSmaranaApplyResult, parseSmaranaPullResult } from '../../shared/smarana.ts';

const { default: pg } = await import(createRequire(new URL('../../karta/package.json', import.meta.url)).resolve('pg'));
// Only the explicitly configured disposable local CI cluster is eligible.
// Never inspect application DATABASE_URL or connect to an application database.
const host = process.env.PURAMA_TRIAL_TEST_PG_HOST;
const expectedData = process.env.PURAMA_TRIAL_TEST_PG_DATA;
const port = Number(process.env.PURAMA_TRIAL_TEST_PG_PORT || 5432);
assert(host && (host === '127.0.0.1' || host.startsWith('/')), 'Explicit local test host required');
assert(expectedData, 'Explicit disposable cluster data directory required');
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Valid local test port required');
const connection = {
  host, port, user: process.env.PURAMA_TRIAL_TEST_PG_USER || 'postgres',
  password: () => process.env.PURAMA_TRIAL_TEST_PG_PASSWORD || '', ssl: false,
  options: '-c search_path=pg_catalog', database: 'postgres', connectionTimeoutMillis: 5000, statement_timeout: 12000,
};
const suffix = randomUUID().replaceAll('-', '');
const database = `purama_smarana_test_${suffix}`;
assert(/^purama_smarana_test_[0-9a-f]{32}$/.test(database));
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const clients = new Set();
let cluster;
let admin;
let created = false;
const mutation = (overrides = {}) => ({ schemaVersion: 1, ownerId: owner, resourceId: randomUUID(), mutationId: randomUUID(),
  baseRevision: 0, tombstone: false, payload: { title: 'Fixture privée', messages: [], draft: 'Brouillon' }, ...overrides });

async function connect(name, target = database) {
  const client = new pg.Client({ ...connection, database: target, application_name: `smarana_${suffix.slice(0, 8)}_${name}` });
  await client.connect(); clients.add(client);
  assert(Number.isInteger(client.processID), 'An observable backend PID is required');
  return client;
}
async function close(client) {
  if (!client || !clients.has(client)) return;
  try { await client.end(); } finally { clients.delete(client); }
}
async function authorize(client, userId = owner) {
  await client.query('SET ROLE authenticated');
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [userId]);
}
async function apply(client, input) {
  return parseSmaranaApplyResult((await client.query('SELECT purama_ai.smarana_apply($1,$2::jsonb) AS value',
    [input.ownerId, JSON.stringify(input)])).rows[0].value);
}
async function pull(client, afterCursor = '0', userId = owner) {
  return parseSmaranaPullResult((await client.query('SELECT purama_ai.smarana_pull($1,$2,20) AS value', [userId, afterCursor])).rows[0].value);
}
async function waitForBlocker(waiting, blocker) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const row = (await admin.query('SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked', [blocker.processID, waiting.processID])).rows[0];
    if (row.blocked) return;
    await delay(20);
  }
  assert.fail('Expected database lock barrier was not observed');
}
async function scenario(work) {
  const [first, second, third] = await Promise.all(['first', 'second', 'third'].map(name => connect(name)));
  try {
    await Promise.all([authorize(first), authorize(second), authorize(third, other)]);
    await work(first, second, third);
  } finally {
    await Promise.allSettled([first, second, third].map(client => client.query('ROLLBACK')));
    await Promise.allSettled([first, second, third].map(close));
  }
}

before(async () => {
  cluster = await connect('cluster', 'postgres');
  const settings = (await cluster.query(`SELECT current_database() AS database,current_user AS username,
    current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen,
    current_setting('server_version_num')::integer AS version,inet_server_addr() AS address`)).rows[0];
  assert.equal(settings.database, 'postgres'); assert.equal(settings.username, connection.user);
  assert.equal(settings.data, expectedData, 'Unexpected cluster data directory');
  assert(settings.version >= 180000 && settings.version < 190000, 'PostgreSQL 18 disposable qualification cluster required');
  if (host.startsWith('/')) { assert.equal(settings.listen, ''); assert.equal(settings.address, null); }
  const roles = (await cluster.query(`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,
    rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles
    WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [['anon', 'authenticated', 'service_role']])).rows;
  assert.deepEqual(roles, ['anon', 'authenticated', 'service_role'].map(rolname => ({ rolname, rolsuper: false,
    rolinherit: true, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false, rolreplication: false,
    rolbypassrls: rolname === 'service_role', rolconnlimit: -1, rolvaliduntil: null, rolconfig: null })), 'Unexpected fixture roles');
  assert.equal((await cluster.query(`SELECT 1 FROM pg_auth_members m WHERE
    m.roleid IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[])) OR
    m.member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1::text[]))`, [['anon', 'authenticated', 'service_role']])).rowCount, 0);
  await cluster.query(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true;
  admin = await connect('admin');
  assert.equal((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname IN ('auth','purama_ai')")).rowCount, 0);
  await admin.query(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
  await admin.query(readFileSync(new URL('../../supabase/migrations/20261123180000_smarana_replication.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await admin.query('TRUNCATE auth.users CASCADE');
  await admin.query('INSERT INTO auth.users(id) VALUES($1),($2)', [owner, other]);
});
after(async () => {
  try {
    const closed = await Promise.allSettled([...clients].filter(client => client !== cluster).map(close));
    if (created) {
      assert(/^purama_smarana_test_[0-9a-f]{32}$/.test(database));
      await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`); created = false;
    }
    const failure = closed.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  } finally { await close(cluster); }
});

test('owner cursors cannot commit out of order while another account continues independently', async () => scenario(async (first, second, third) => {
  const a = mutation(); const b = mutation();
  await first.query('BEGIN');
  assert.equal((await apply(first, a)).cursor, '1');
  const later = apply(second, b); later.catch(() => {});
  await waitForBlocker(second, first);
  assert.equal((await apply(third, mutation({ ownerId: other }))).cursor, '1');
  await first.query('COMMIT');
  assert.equal((await later).cursor, '2');
  const page = await pull(second);
  assert.deepEqual(page.records.map(row => [row.resourceId, row.cursor]), [[a.resourceId, '1'], [b.resourceId, '2']]);
}));

test('an aborted earlier commit leaves no cursor hole or skipped conversation', async () => scenario(async (first, second) => {
  const discarded = mutation(); const kept = mutation();
  await first.query('BEGIN'); await apply(first, discarded);
  const pending = apply(second, kept); pending.catch(() => {});
  await waitForBlocker(second, first);
  await first.query('ROLLBACK');
  assert.equal((await pending).cursor, '1');
  assert.deepEqual((await pull(second)).records.map(row => row.resourceId), [kept.resourceId]);
}));

test('two simultaneous deliveries of the same mutation receive one durable application', async () => scenario(async (first, second) => {
  const input = mutation();
  await first.query('BEGIN'); const original = await apply(first, input);
  const pending = apply(second, input); pending.catch(() => {});
  await waitForBlocker(second, first);
  await first.query('COMMIT');
  assert.deepEqual(await pending, { ...original, replayed: true });
  assert.equal((await pull(second)).records.length, 1);
  assert.equal((await admin.query('SELECT count(*)::integer AS count FROM purama_ai.smarana_mutations')).rows[0].count, 1);
}));

test('a pull waits for the owner commit and includes the committed version', async () => scenario(async (first, second) => {
  const input = mutation(); await apply(first, input);
  await first.query('BEGIN');
  await apply(first, mutation({ resourceId: input.resourceId, baseRevision: 1, payload: { ...input.payload, draft: 'Committed update' } }));
  const pending = pull(second, '1'); pending.catch(() => {});
  await waitForBlocker(second, first);
  await first.query('COMMIT');
  const page = await pending;
  assert.equal(page.cursor, '2'); assert.equal(page.records[0].payload.draft, 'Committed update');
}));

test('a concurrent tombstone defeats a stale writer without resurrecting its content', async () => scenario(async (first, second) => {
  const input = mutation(); await apply(first, input);
  await first.query('BEGIN');
  await apply(first, mutation({ resourceId: input.resourceId, baseRevision: 1, tombstone: true, payload: null }));
  const pending = apply(second, mutation({ resourceId: input.resourceId, baseRevision: 1, payload: input.payload })); pending.catch(() => {});
  await waitForBlocker(second, first);
  await first.query('COMMIT');
  assert.equal((await pending).reason, 'deleted');
  assert.equal((await pull(second)).records[0].payload, null);
}));
