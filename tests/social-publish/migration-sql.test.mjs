import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const original = await readFile(new URL('../../supabase/migrations/20260406120000_social_autopilot.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../../supabase/migrations/20261110000300_social_publish_idempotency.sql', import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const schemas = ['public', 'purama_ai'];
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA purama_ai;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA public, purama_ai, auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
  `);
  // Execute the actual historical migration in each supported deployment schema.
  await db.exec(original);
  await db.exec(original.replaceAll('public.', 'purama_ai.'));
  for (const schema of schemas) {
    await db.exec(`
      INSERT INTO ${schema}.social_posts (user_id, content_text, status, zernio_post_id)
        VALUES ('${owner}', 'Legacy original', 'published', 'legacy-provider-id'),
          ('${other}', 'Other owner', 'scheduled', NULL);
      INSERT INTO ${schema}.social_accounts (user_id, platform, zernio_account_id, zernio_profile_id)
        VALUES ('${owner}', 'facebook', 'legacy-account', 'legacy-profile');
      GRANT ALL ON ${schema}.social_posts, ${schema}.social_accounts TO anon, authenticated;
      GRANT UPDATE (status, zernio_post_id) ON ${schema}.social_posts TO authenticated;
      GRANT UPDATE (zernio_account_id) ON ${schema}.social_accounts TO authenticated;
    `);
  }
  await db.exec(migration);
});
after(async () => { await db?.close(); });

async function asRole(role, work) {
  assert(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); } finally { await db.exec('RESET ROLE'); }
}

for (const schema of schemas) {
  test(`${schema}: migration preserves historical content, IDs and unverified accounts`, async () => {
    const old = await db.query(`SELECT content_text,status,zernio_post_id,client_request_id,request_hash,target_accounts
      FROM ${schema}.social_posts WHERE content_text = 'Legacy original'`);
    assert.deepEqual(old.rows, [{ content_text: 'Legacy original', status: 'published', zernio_post_id: 'legacy-provider-id', client_request_id: null, request_hash: null, target_accounts: null }]);
    const accounts = await db.query(`SELECT zernio_account_id,publishing_verified_at FROM ${schema}.social_accounts`);
    assert.deepEqual(accounts.rows, [{ zernio_account_id: 'legacy-account', publishing_verified_at: null }]);
  });

  test(`${schema}: unique user/key is enforced by PostgreSQL independently of route logic`, async () => {
    const insert = (user, hash = 'a'.repeat(64)) => db.query(`INSERT INTO ${schema}.social_posts
      (user_id,client_request_id,request_hash,status) VALUES ($1,$2,$3,'publishing')`, [user, 'request-key-000001', hash]);
    await asRole('service_role', () => insert(owner));
    await assert.rejects(asRole('service_role', () => insert(owner)), /duplicate key/);
    await assert.rejects(asRole('service_role', () => insert(owner, 'b'.repeat(64))), /duplicate key/);
    await asRole('service_role', () => insert(other));
    const count = await db.query(`SELECT count(*)::int AS count FROM ${schema}.social_posts WHERE client_request_id = 'request-key-000001'`);
    assert.equal(count.rows[0].count, 2);
  });

  test(`${schema}: incomplete or malformed request identity is rejected atomically`, async () => {
    for (const [key, hash] of [['request-key-000002', null], [null, 'a'.repeat(64)], ['tiny', 'a'.repeat(64)], ['request-key-000002', 'not-a-hash']]) {
      await assert.rejects(asRole('service_role', () => db.query(`INSERT INTO ${schema}.social_posts
        (user_id,client_request_id,request_hash) VALUES ($1,$2,$3)`, [owner, key, hash])), /social_posts_request_identity_check/);
    }
  });

  test(`${schema}: server can persist an uncertain result but authenticated clients cannot forge it`, async () => {
    await asRole('service_role', () => db.query(`UPDATE ${schema}.social_posts SET status = 'publish_unconfirmed'
      WHERE user_id = $1 AND client_request_id = 'request-key-000001'`, [owner]));
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner]);
    for (const sql of [
      `UPDATE ${schema}.social_posts SET status = 'published'`,
      `UPDATE ${schema}.social_posts SET zernio_post_id = 'forged'`,
      `DELETE FROM ${schema}.social_posts`,
      `INSERT INTO ${schema}.social_posts (user_id) VALUES ('${owner}')`,
      `UPDATE ${schema}.social_accounts SET zernio_account_id = 'foreign-account'`,
      `UPDATE ${schema}.social_accounts SET publishing_verified_at = now()`,
      `UPDATE ${schema}.social_accounts SET is_active = true`,
      `DELETE FROM ${schema}.social_accounts`,
    ]) await assert.rejects(asRole('authenticated', () => db.exec(sql)), /permission denied/);
    const privilege = await db.query(`SELECT has_column_privilege('authenticated','${schema}.social_posts','status','UPDATE') AS can_update`);
    assert.equal(privilege.rows[0].can_update, false);
  });

  test(`${schema}: authenticated owner reads only own rows and anon cannot read`, async () => {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [owner]);
    const result = await asRole('authenticated', () => db.query(`SELECT user_id FROM ${schema}.social_posts`));
    assert(result.rows.length > 0);
    assert(result.rows.every((row) => row.user_id === owner));
    await assert.rejects(asRole('anon', () => db.query(`SELECT * FROM ${schema}.social_posts`)), /permission denied/);
  });
}

test('migration is repeatable and does not invent a missing deployment schema', async () => {
  const beforeRows = await db.query('SELECT id,content_text,status FROM public.social_posts ORDER BY id');
  await db.exec('DROP SCHEMA purama_ai CASCADE');
  await db.exec(migration);
  const afterRows = await db.query('SELECT id,content_text,status FROM public.social_posts ORDER BY id');
  assert.deepEqual(afterRows.rows, beforeRows.rows);
  assert.equal((await db.query("SELECT to_regclass('purama_ai.social_posts') AS name")).rows[0].name, null);
});
