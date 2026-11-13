import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const AGENT = '10000000-0000-4000-8000-000000000001';
const defaults = { reflection: 'auto', speed: 'standard' };

test('saved execution preferences — real PostgreSQL migration and ownership', { timeout: 60_000 }, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
    `);
    await db.exec(migration('20260407000000_creator_agent'));
    await db.exec(migration('20261110001000_creator_public_distribution'));
    await db.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [OWNER, OTHER]);
    await db.query("INSERT INTO purama_ai.creator_agents (id, user_id, name, slug, system_prompt, is_public) VALUES ($1, $2, 'My agent', 'my-agent', 'Help', true)", [AGENT, OWNER]);
    const securitySnapshot = async () => ({
      policies: (await db.query("SELECT polname, polcmd, polroles, pg_get_expr(polqual, polrelid) AS using_expression, pg_get_expr(polwithcheck, polrelid) AS check_expression FROM pg_policy WHERE polrelid = 'purama_ai.creator_agents'::regclass ORDER BY polname")).rows,
      table: (await db.query("SELECT relrowsecurity, relforcerowsecurity, relacl::text FROM pg_class WHERE oid = 'purama_ai.creator_agents'::regclass")).rows,
    });
    const before = await securitySnapshot();
    await db.exec(migration('20261112233000_creator_execution_preferences'));

    async function identity(id) {
      await db.exec('SET LOCAL ROLE authenticated');
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [id]);
    }
    async function transaction(run) {
      await db.exec('BEGIN');
      try { await run(); } finally { await db.exec('ROLLBACK'); }
    }

    await t.test('preserves every existing RLS policy and table grant', async () => {
      assert.deepEqual(await securitySnapshot(), before);
    });
    await t.test('backfills existing rows and defaults new rows', async () => {
      assert.deepEqual((await db.query('SELECT execution_preferences FROM purama_ai.creator_agents WHERE id = $1', [AGENT])).rows[0].execution_preferences, defaults);
      await transaction(async () => {
        await identity(OWNER);
        const result = await db.query("INSERT INTO purama_ai.creator_agents (user_id, name, slug, system_prompt) VALUES ($1, 'New', 'new-agent', 'Help') RETURNING execution_preferences", [OWNER]);
        assert.deepEqual(result.rows[0].execution_preferences, defaults);
      });
    });
    await t.test('owner can save and reload all supported combinations', async () => {
      await transaction(async () => {
        await identity(OWNER);
        for (const reflection of ['auto', 'standard', 'deep', 'maximum']) {
          for (const speed of ['standard', 'fast', 'ultra_fast']) {
            const chosen = { reflection, speed };
            await db.query('UPDATE purama_ai.creator_agents SET execution_preferences = $1::jsonb WHERE id = $2', [JSON.stringify(chosen), AGENT]);
            const result = await db.query('SELECT execution_preferences FROM purama_ai.creator_agents WHERE id = $1', [AGENT]);
            assert.deepEqual(result.rows[0].execution_preferences, chosen);
          }
        }
      });
    });
    await t.test('rejects SQL null, JSON null, missing keys, extra keys and invalid enum types', async () => {
      const invalid = [
        null, 'null', '{}', '[]', '1', '"fast"',
        '{"reflection":"deep"}', '{"speed":"fast"}',
        '{"reflection":null,"speed":"fast"}', '{"reflection":"deep","speed":null}',
        '{"reflection":"unlimited","speed":"fast"}', '{"reflection":"deep","speed":"instant"}',
        '{"reflection":1,"speed":"fast"}', '{"reflection":"deep","speed":true}',
        '{"reflection":"deep","speed":"fast","model":"unqualified"}',
      ];
      for (const value of invalid) {
        await transaction(async () => {
          await identity(OWNER);
          await assert.rejects(
            db.query('UPDATE purama_ai.creator_agents SET execution_preferences = $1::jsonb WHERE id = $2', [value, AGENT]),
            error => ['23502', '23514'].includes(error.code),
            `Invalid profile must be rejected: ${value}`,
          );
        });
        assert.deepEqual((await db.query('SELECT execution_preferences FROM purama_ai.creator_agents WHERE id = $1', [AGENT])).rows[0].execution_preferences, defaults);
      }
    });
    await t.test('another account cannot read or update the private saved settings', async () => {
      await transaction(async () => {
        await identity(OTHER);
        assert.deepEqual((await db.query('SELECT execution_preferences FROM purama_ai.creator_agents WHERE id = $1', [AGENT])).rows, []);
        assert.deepEqual((await db.query('UPDATE purama_ai.creator_agents SET execution_preferences = $1::jsonb WHERE id = $2 RETURNING id', [JSON.stringify({ reflection: 'maximum', speed: 'ultra_fast' }), AGENT])).rows, []);
        const publicRows = (await db.query('SELECT * FROM purama_ai.public_creator_models($1::uuid)', [AGENT])).rows;
        assert.equal(publicRows.length, 1);
        assert.equal(Object.hasOwn(publicRows[0], 'execution_preferences'), false);
      });
    });
    await t.test('anonymous users still have no direct table privileges', async () => {
      await transaction(async () => {
        await db.exec('SET LOCAL ROLE anon');
        await assert.rejects(db.query('SELECT execution_preferences FROM purama_ai.creator_agents'), error => error.code === '42501');
      });
    });
  } finally { await db.close(); }
});
