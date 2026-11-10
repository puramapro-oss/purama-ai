import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../../karta/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const migration = readFileSync(new URL('../../supabase/migrations/20261110233000_oauth_connection_states.sql', import.meta.url), 'utf8');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const hash = value => createHash('sha256').update(value).digest('hex');
let db;
test.before(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA purama_ai;
    GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${OWNER}'), ('${OTHER}');`);
  await db.exec(migration);
});
test.after(async () => { await db?.close(); });
test.beforeEach(async () => { await db.exec('RESET ROLE; DELETE FROM purama_ai.oauth_connection_states;'); });
const issue = (state = 'state', purpose = 'google_connections', provider = 'gmail', actor = OWNER) => db.query(
  'SELECT purama_ai.create_oauth_connection_state($1,$2,$3,$4) AS expires_at', [hash(state), actor, purpose, provider]);
const consume = (state = 'state', purpose = 'google_connections', actor = OWNER) => db.query(
  'SELECT * FROM purama_ai.consume_oauth_connection_state($1,$2,$3)', [hash(state), purpose, actor]);

for (const role of ['anon', 'authenticated']) {
  for (const operation of ['select', 'create', 'consume']) {
    test(`${role} cannot ${operation} private OAuth admission state`, async () => {
      await issue();
      await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
      try {
        await assert.rejects(() => operation === 'select'
          ? db.query('SELECT * FROM purama_ai.oauth_connection_states')
          : operation === 'create' ? issue('other') : consume(), { code: '42501' });
      } finally { await db.exec('ROLLBACK'); }
    });
  }
}

test('service role can issue and consume a state without SECURITY DEFINER', async () => {
  await db.exec('BEGIN; SET LOCAL ROLE service_role;');
  try {
    await issue(); const result = await consume();
    assert.deepEqual(result.rows, [{ user_id: OWNER, provider: 'gmail', return_path: '/mes-connexions' }]);
  } finally { await db.exec('ROLLBACK'); }
  const functions = await db.query(`SELECT p.proname, p.prosecdef, p.proconfig FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid=p.pronamespace WHERE n.nspname='purama_ai'`);
  assert.equal(functions.rows.length, 2);
  for (const fn of functions.rows) { assert.equal(fn.prosecdef, false); assert.deepEqual(fn.proconfig, ['search_path=""']); }
});

test('expiry is ten minutes from SQL creation, never supplied by the browser', async () => {
  await issue(); const { rows: [state] } = await db.query(`SELECT extract(epoch FROM expires_at-created_at)::int AS seconds
    FROM purama_ai.oauth_connection_states`);
  assert.equal(state.seconds, 600);
});

test('a state can be consumed only once', async () => {
  await issue(); assert.equal((await consume()).rows.length, 1); assert.equal((await consume()).rows.length, 0);
});

test('twelve pending consumers of the SQL function admit only one result', async () => {
  await issue();
  // PGlite queues these on one embedded connection. Native connection races are
  // a separate gate; this does not claim twelve independent PostgreSQL sessions.
  const results = await Promise.all(Array.from({ length: 12 }, () => consume()));
  assert.equal(results.reduce((count, result) => count + result.rows.length, 0), 1);
  assert.equal((await db.query('SELECT count(*)::int AS total FROM purama_ai.oauth_connection_states WHERE consumed_at IS NOT NULL')).rows[0].total, 1);
});

test('a wrong actor does not consume the owner state', async () => {
  await issue(); assert.equal((await consume('state', 'google_connections', OTHER)).rows.length, 0);
  assert.equal((await consume()).rows.length, 1);
});

test('a Google callback without an authenticated actor cannot consume its state', async () => {
  await issue(); assert.equal((await consume('state', 'google_connections', null)).rows.length, 0);
  assert.equal((await consume()).rows.length, 1);
});

test('Google and Gmail callback purposes cannot substitute for one another', async () => {
  await issue(); assert.equal((await consume('state', 'email_agent_gmail', null)).rows.length, 0);
  assert.equal((await consume()).rows.length, 1);
  await issue('gmail-state', 'email_agent_gmail');
  assert.equal((await consume('gmail-state', 'google_connections', OWNER)).rows.length, 0);
  assert.equal((await consume('gmail-state', 'email_agent_gmail', null)).rows.length, 0);
  assert.equal((await consume('gmail-state', 'email_agent_gmail', OTHER)).rows.length, 0);
  assert.deepEqual((await consume('gmail-state', 'email_agent_gmail', OWNER)).rows,
    [{ user_id: OWNER, provider: 'gmail', return_path: '/dashboard/email-agent' }]);
});

test('an expired state is rejected without a provider admission', async () => {
  await issue(); await db.query(`UPDATE purama_ai.oauth_connection_states
    SET created_at=clock_timestamp()-interval '20 minutes', expires_at=clock_timestamp()-interval '10 minutes'`);
  assert.equal((await consume()).rows.length, 0);
  assert.equal((await db.query('SELECT consumed_at FROM purama_ai.oauth_connection_states')).rows[0].consumed_at, null);
});

test('an unknown state cannot be accepted', async () => { assert.equal((await consume()).rows.length, 0); });

test('invalid purposes/providers never enter the state registry', async () => {
  for (const [purpose, provider] of [['unknown', 'gmail'], ['email_agent_gmail', 'google_drive'], ['google_connections', 'admin'], [null, 'gmail']]) {
    await assert.rejects(() => issue('bad', purpose, provider), { code: '22023' });
  }
  assert.equal((await db.query('SELECT count(*)::int AS total FROM purama_ai.oauth_connection_states')).rows[0].total, 0);
});

test('new authorization preserves a live state from another tab', async () => {
  await issue('first'); await issue('second');
  assert.equal((await consume('first')).rows.length, 1); assert.equal((await consume('second')).rows.length, 1);
});

test('cleanup is restricted to the actor issuing a new state', async () => {
  await issue('other-state', 'google_connections', 'gmail', OTHER); await issue('owner-expired');
  await db.query(`UPDATE purama_ai.oauth_connection_states
    SET created_at=clock_timestamp()-interval '20 minutes', expires_at=clock_timestamp()-interval '10 minutes'`);
  await issue('new-state');
  const { rows } = await db.query('SELECT user_id FROM purama_ai.oauth_connection_states ORDER BY user_id');
  assert.deepEqual(rows, [{ user_id: OWNER }, { user_id: OTHER }]);
});
