import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const main = 'claude-sonnet-4-6';
const retired = 'claude-sonnet-4-20250514';
const owner = '81000000-0000-4000-8000-000000000001';

// One disposable PostgreSQL/WASM database, with the production SQL unchanged.
// This qualifies migration semantics; it does not apply a production migration.
it('migrates only the retired model, preserves current distribution policies and is idempotent', async () => {
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
    await db.exec(migration('20260407000000_creator_agent.sql'));
    await db.exec(migration('20261110001000_creator_public_distribution.sql'));
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [owner]);
    for (const [slug, model] of [
      ['old-owned', retired], ['fast-owned', 'claude-haiku-4-5-20251001'],
      ['current-owned', main], ['custom-owned', 'host-qualified-custom'], ['null-owned', null],
    ]) {
      await db.query(`INSERT INTO purama_ai.creator_agents
        (user_id, name, slug, system_prompt, model, updated_at)
        VALUES ($1, $2, $2, 'Fictitious prompt', $3, '2001-01-01T00:00:00Z')`, [owner, slug, model]);
    }
    const tableSql = 'SELECT * FROM purama_ai.creator_agents ORDER BY id';
    const securitySql = `SELECT c.relrowsecurity, c.relforcerowsecurity, c.relacl,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p
        WHERE p.schemaname = 'purama_ai' AND p.tablename = 'creator_agents') AS policies
      FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'purama_ai' AND c.relname = 'creator_agents'`;
    const beforeRows = (await db.query<Record<string, unknown>>(tableSql)).rows;
    const beforeSecurity = (await db.query(securitySql)).rows;
    expect(beforeRows.filter(row => row.user_id === null && row.model === retired)).toHaveLength(9);
    const sql = migration('20261009000000_creator_agent_model_default_fix.sql');
    await db.exec(sql);
    const afterRows = (await db.query<Record<string, unknown>>(tableSql)).rows;
    expect(afterRows).toHaveLength(beforeRows.length);
    for (const before of beforeRows) {
      const after = afterRows.find(row => row.id === before.id)!;
      if (before.model === retired) {
        expect(after).toEqual({ ...before, model: main, updated_at: after.updated_at });
        if (before.slug === 'old-owned') expect(after.updated_at).not.toEqual(before.updated_at);
      } else {
        expect(after).toEqual(before);
      }
    }
    expect((await db.query(securitySql)).rows).toEqual(beforeSecurity);
    await db.exec(sql);
    expect((await db.query(tableSql)).rows).toEqual(afterRows);
    const inserted = await db.query<{ model: string }>(`INSERT INTO purama_ai.creator_agents
      (user_id, name, slug, system_prompt) VALUES ($1, 'New agent', 'new-agent', 'Fictitious prompt')
      RETURNING model`, [owner]);
    expect(inserted.rows).toEqual([{ model: main }]);
  } finally {
    await db.close();
  }
}, 30_000);
