import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Execute the actual migrations, not rewritten equivalents. This is one
// PostgreSQL/WASM connection: serial authorization and replay tests, not a
// multi-connection concurrency or deployed Supabase integration test.
const originalMigration = readFileSync(
  new URL('../supabase/migrations/20260407000000_creator_agent.sql', import.meta.url), 'utf8',
);
const distributionMigration = readFileSync(
  new URL('../supabase/migrations/20261110001000_creator_public_distribution.sql', import.meta.url), 'utf8',
);
const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';
const PUBLIC_A = '10000000-0000-4000-8000-000000000001';
const PRIVATE_A = '10000000-0000-4000-8000-000000000002';
const OTHER_SOURCE = '10000000-0000-4000-8000-000000000003';
const OWNED_OFFICIAL = '10000000-0000-4000-8000-000000000004';
const NULL_TEMPLATE = '10000000-0000-4000-8000-000000000005';
const COPY_ID = '20000000-0000-4000-8000-000000000001';
const SECOND_COPY_ID = '20000000-0000-4000-8000-000000000002';
const FOREIGN_COPY_ID = '20000000-0000-4000-8000-000000000003';
const OWN_NEW_ID = '20000000-0000-4000-8000-000000000004';
const HISTORY_ID = '30000000-0000-4000-8000-000000000001';
const CHAT_ID = '30000000-0000-4000-8000-000000000002';
const SESSION_ID = '30000000-0000-4000-8000-000000000003';
const NEW_HISTORY_ID = '30000000-0000-4000-8000-000000000004';
const NEW_CHAT_ID = '30000000-0000-4000-8000-000000000005';
const TABLES = ['creator_agents', 'creator_agent_runs', 'creator_agent_chats'];
const PUBLIC_FIELDS = [
  'id', 'name', 'description', 'emoji', 'color', 'category',
  'is_public', 'is_template', 'is_active',
].sort();
const CLONE_SQL = 'SELECT * FROM purama_ai.clone_public_creator_model($1::uuid, $2::uuid, $3::uuid)';

test('creator public distribution — real PostgreSQL authorization and copy contract', { timeout: 180_000 }, async (t) => {
  const db = new PGlite();
  try {
    await db.exec([
      'CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;',
      'CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;',
      'CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;',
      'CREATE SCHEMA auth;',
      'CREATE TABLE auth.users (id uuid PRIMARY KEY);',
      "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;",
      'GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;',
      'GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;',
    ].join('\n'));
    await db.exec(originalMigration);
    await db.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B]);

    async function insertFixture(id, name, isPublic = false, isTemplate = false, clonedFrom = null) {
      await db.query(
        'INSERT INTO purama_ai.creator_agents (id, user_id, name, slug, description, emoji, color, category, system_prompt, model, temperature, max_tokens, tools_enabled, is_public, is_template, cloned_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
        [id, USER_A, name, 'fixture-' + id, 'A public description', '🧪', '#123456', 'productivity',
          'Reusable prompt from user A', 'test-model', 0.4, 1024, ['web_search'], isPublic, isTemplate, clonedFrom],
      );
    }
    await insertFixture(PUBLIC_A, 'Published model', true);
    await insertFixture(PRIVATE_A, 'Private model');
    await insertFixture(OTHER_SOURCE, 'Other published model', true);
    await insertFixture(OWNED_OFFICIAL, 'Official model assigned to A', false, true);
    await insertFixture(NULL_TEMPLATE, 'Legacy null template flag', false, null);
    await insertFixture(FOREIGN_COPY_ID, 'A different account’s existing copy', false, false, PUBLIC_A);
    // Simulate an already-installed two-argument RPC. Its removal must be
    // exercised during migration, not merely inferred from a fresh database.
    await db.exec([
      "CREATE FUNCTION purama_ai.clone_public_creator_model(p_source_id uuid, p_copy_id uuid) RETURNS SETOF purama_ai.creator_agents LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT a.* FROM purama_ai.creator_agents AS a WHERE a.id = p_source_id $$;",
      'REVOKE ALL ON FUNCTION purama_ai.clone_public_creator_model(uuid, uuid) FROM PUBLIC;',
      'GRANT EXECUTE ON FUNCTION purama_ai.clone_public_creator_model(uuid, uuid) TO authenticated;',
    ].join('\n'));
    // Legacy NULL and user-owned "official" rows must be repaired by the actual
    // distribution migration rather than hidden by sanitized test fixtures.
    await db.exec(distributionMigration);
    await db.query(
      "UPDATE purama_ai.creator_agents SET schedule_enabled = true, schedule_cron = '0 * * * *', schedule_input = $2::jsonb, last_scheduled_run = '2025-01-01T00:00:00Z', karta_enabled = true, total_runs = 42, total_tokens = 777, avg_rating = 4.5, created_at = '2025-01-01T00:00:00Z' WHERE id = $1",
      [PUBLIC_A, JSON.stringify({ private_input: 'OWNER_A_SCHEDULE_SECRET' })],
    );
    await db.query(
      "INSERT INTO purama_ai.creator_agent_runs (id, user_id, agent_id, trigger, input, output, status, tokens_input, tokens_output) VALUES ($1, $2, $3, 'manual', 'OWNER_A_PRIVATE_RUN_INPUT', 'OWNER_A_PRIVATE_RUN_OUTPUT', 'success', 10, 20)",
      [HISTORY_ID, USER_A, PUBLIC_A],
    );
    await db.query(
      "INSERT INTO purama_ai.creator_agent_chats (id, user_id, agent_id, session_id, role, content, tokens) VALUES ($1, $2, $3, $4, 'user', 'OWNER_A_PRIVATE_CHAT', 10)",
      [CHAT_ID, USER_A, PUBLIC_A, SESSION_ID],
    );
    const { rows: officialRows } = await db.query(
      'SELECT id FROM purama_ai.creator_agents WHERE is_template = true AND user_id IS NULL ORDER BY name LIMIT 1',
    );
    assert.equal(officialRows.length, 1, 'The original migration’s official seed is loaded');
    const officialId = officialRows[0].id;

    async function identity(role, userId = null) {
      assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
      await db.exec('SET LOCAL ROLE ' + role);
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId ?? '']);
    }

    async function expectSqlState(sql, parameters, state, message) {
      // Expected PostgreSQL errors abort the transaction. Roll back only the
      // attempted statement so subsequent assertions still run under real RLS.
      await db.exec('SAVEPOINT expected_failure');
      let failure;
      try {
        await db.query(sql, parameters);
      } catch (error) {
        failure = error;
      } finally {
        await db.exec('ROLLBACK TO SAVEPOINT expected_failure');
        await db.exec('RELEASE SAVEPOINT expected_failure');
      }
      assert.ok(failure, 'SQL must reject: ' + sql);
      assert.equal(failure.code, state, failure.message);
      if (message) assert.match(failure.message, message);
    }

    async function sqlCase(name, run) {
      await t.test(name, async () => {
        await db.exec('BEGIN');
        try {
          await run();
        } finally {
          await db.exec('ROLLBACK');
        }
      });
    }

    async function clone(sourceId = PUBLIC_A, copyId = COPY_ID, expectedUserId = USER_B) {
      const { rows } = await db.query(
        CLONE_SQL, [sourceId, copyId, expectedUserId],
      );
      assert.equal(rows.length, 1);
      return rows[0];
    }

    await sqlCase('migration repairs inherited official/null flags and makes the flag non-nullable', async () => {
      assert.deepEqual((await db.query(
        'SELECT id, is_template FROM purama_ai.creator_agents WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[OWNED_OFFICIAL, NULL_TEMPLATE]],
      )).rows, [
        { id: OWNED_OFFICIAL, is_template: false },
        { id: NULL_TEMPLATE, is_template: false },
      ]);
      assert.equal((await db.query(
        "SELECT attnotnull FROM pg_catalog.pg_attribute WHERE attrelid = 'purama_ai.creator_agents'::regclass AND attname = 'is_template'",
      )).rows[0].attnotnull, true);
      await identity('service_role');
      await expectSqlState(
        'UPDATE purama_ai.creator_agents SET is_template = NULL WHERE id = $1', [NULL_TEMPLATE], '23502',
      );
    });

    await sqlCase('public RPC returns exactly the safe projection with no owner, prompt or scheduling input', async () => {
      await identity('anon');
      const { rows } = await db.query('SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A]);
      assert.deepEqual(rows, [{
        id: PUBLIC_A, name: 'Published model', description: 'A public description',
        emoji: '🧪', color: '#123456', category: 'productivity',
        is_public: true, is_template: false, is_active: true,
      }]);
      assert.deepEqual(Object.keys(rows[0]).sort(), PUBLIC_FIELDS);
      for (const hidden of ['user_id', 'system_prompt', 'schedule_input', 'schedule_cron', 'tools_enabled', 'total_runs']) {
        assert.equal(Object.hasOwn(rows[0], hidden), false);
      }
      assert.equal(JSON.stringify(rows).includes('OWNER_A_'), false);
      assert.equal(JSON.stringify(rows).includes(USER_A), false);
    });

    await sqlCase('blank titles are unavailable through both the public catalogue and a fresh copy request', async () => {
      for (const name of ['', '   ', '\t\r\n  ']) {
        await identity('authenticated', USER_A);
        await db.query('UPDATE purama_ai.creator_agents SET name = $2 WHERE id = $1', [PUBLIC_A, name]);
        await identity('anon');
        assert.deepEqual((await db.query(
          'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A],
        )).rows, []);
        await identity('authenticated', USER_B);
        await expectSqlState(
          CLONE_SQL, [PUBLIC_A, COPY_ID, USER_B], 'P0002',
        );
      }
    });

    await sqlCase('public display fields are trimmed, bounded and filtered without changing the owner’s source', async () => {
      const longName = '\t  ' + 'É'.repeat(200) + '  \n';
      const longDescription = '  ' + 'd'.repeat(2000) + '  ';
      await identity('authenticated', USER_A);
      await db.query(
        'UPDATE purama_ai.creator_agents SET name = $2, description = $3, emoji = $4, color = $5, category = $6 WHERE id = $1',
        [PUBLIC_A, longName, longDescription, '🧪'.repeat(20), 'url(untrusted)', 'unsupported-category'],
      );
      await identity('anon');
      const { rows } = await db.query('SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A]);
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]).sort(), PUBLIC_FIELDS);
      assert.equal(rows[0].name, 'É'.repeat(160));
      assert.equal(rows[0].description, 'd'.repeat(1600));
      assert.equal(rows[0].emoji, '🧪'.repeat(16));
      assert.equal(Array.from(rows[0].emoji).length, 16, 'PostgreSQL counts characters, not UTF-16 code units');
      assert.equal(rows[0].color, '#8B5CF6');
      assert.equal(rows[0].category, null);
      await identity('authenticated', USER_A);
      const original = (await db.query(
        'SELECT name, description, emoji FROM purama_ai.creator_agents WHERE id = $1', [PUBLIC_A],
      )).rows[0];
      assert.deepEqual(original, {
        name: longName, description: longDescription, emoji: '🧪'.repeat(20),
      });
    });

    await sqlCase('public catalogue keeps official/community scopes and excludes private models', async () => {
      await identity('anon');
      const official = await db.query("SELECT * FROM purama_ai.public_creator_models(NULL, 'official')");
      assert.ok(official.rows.some((row) => row.id === officialId));
      assert.ok(official.rows.every((row) => row.is_template === true && row.is_active === true));
      const community = await db.query("SELECT * FROM purama_ai.public_creator_models(NULL, 'community')");
      assert.deepEqual(community.rows.map((row) => row.id).sort(), [PUBLIC_A, OTHER_SOURCE].sort());
      assert.deepEqual((await db.query(
        'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PRIVATE_A],
      )).rows, []);
      assert.deepEqual((await db.query(
        "SELECT * FROM purama_ai.public_creator_models(NULL, 'unknown-kind')",
      )).rows, []);
    });

    await sqlCase('a user-owned flag cannot impersonate an official seed even after a privileged import', async () => {
      await identity('service_role');
      await db.query(
        'UPDATE purama_ai.creator_agents SET is_template = true WHERE id = ANY($1::uuid[])',
        [[PUBLIC_A, PRIVATE_A]],
      );
      await identity('anon');
      assert.deepEqual((await db.query(
        'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PRIVATE_A],
      )).rows, [], 'An owned private row must not become public through the flag');
      assert.deepEqual((await db.query(
        'SELECT is_public, is_template FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A],
      )).rows, [{ is_public: true, is_template: false }]);
      assert.deepEqual((await db.query(
        "SELECT id FROM purama_ai.public_creator_models($1::uuid, 'official')", [PUBLIC_A],
      )).rows, []);
      assert.deepEqual((await db.query(
        "SELECT id FROM purama_ai.public_creator_models($1::uuid, 'community')", [PUBLIC_A],
      )).rows, [{ id: PUBLIC_A }]);
      await identity('authenticated', USER_B);
      await expectSqlState(
        CLONE_SQL, [PRIVATE_A, COPY_ID, USER_B], 'P0002',
      );
      const copy = await clone();
      assert.equal(copy.is_template, false);
    });

    await sqlCase('anonymous callers cannot read any underlying table or call the copy RPC', async () => {
      await identity('anon');
      for (const table of TABLES) {
        await expectSqlState('SELECT * FROM purama_ai.' + table, [], '42501');
      }
      await expectSqlState(
        CLONE_SQL, [PUBLIC_A, COPY_ID, USER_B], '42501',
      );
    });

    await sqlCase('user B cannot read user A’s public/private rows or execution/chat history directly', async () => {
      await identity('authenticated', USER_B);
      for (const table of TABLES) {
        assert.deepEqual((await db.query('SELECT * FROM purama_ai.' + table)).rows, []);
      }
      assert.equal((await db.query(
        'SELECT id FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A],
      )).rows.length, 1, 'The safe public description remains available');
    });

    await sqlCase('owner CRUD remains available while ownership spoofing and foreign mutations are rejected', async () => {
      await identity('authenticated', USER_A);
      const own = await db.query('SELECT id FROM purama_ai.creator_agents WHERE id = $1', [PRIVATE_A]);
      assert.deepEqual(own.rows, [{ id: PRIVATE_A }]);
      await db.query(
        "INSERT INTO purama_ai.creator_agents (id, user_id, name, slug, system_prompt) VALUES ($1, $2, 'Own draft', 'own-new', 'Own prompt')",
        [OWN_NEW_ID, USER_A],
      );
      assert.deepEqual((await db.query(
        "UPDATE purama_ai.creator_agents SET name = 'Updated own draft', is_public = true WHERE id = $1 RETURNING name, is_public",
        [OWN_NEW_ID],
      )).rows, [{ name: 'Updated own draft', is_public: true }]);
      assert.deepEqual((await db.query(
        'DELETE FROM purama_ai.creator_agents WHERE id = $1 RETURNING id', [OWN_NEW_ID],
      )).rows, [{ id: OWN_NEW_ID }]);
      await expectSqlState(
        "INSERT INTO purama_ai.creator_agents (id, user_id, name, slug, system_prompt) VALUES ($1, $2, 'Spoofed', 'spoofed', 'Prompt')",
        [OWN_NEW_ID, USER_B], '42501',
      );
      await expectSqlState(
        'UPDATE purama_ai.creator_agents SET user_id = $1 WHERE id = $2', [USER_B, PRIVATE_A], '42501',
      );
      await identity('authenticated', USER_B);
      assert.deepEqual((await db.query(
        "UPDATE purama_ai.creator_agents SET name = 'Foreign mutation' WHERE id = $1 RETURNING id", [PRIVATE_A],
      )).rows, []);
      assert.deepEqual((await db.query(
        'DELETE FROM purama_ai.creator_agents WHERE id = $1 RETURNING id', [PRIVATE_A],
      )).rows, []);
    });

    await sqlCase('owners retain CRUD on their own execution and chat history', async () => {
      await identity('authenticated', USER_A);
      assert.deepEqual((await db.query(
        'SELECT input FROM purama_ai.creator_agent_runs WHERE id = $1', [HISTORY_ID],
      )).rows, [{ input: 'OWNER_A_PRIVATE_RUN_INPUT' }]);
      assert.deepEqual((await db.query(
        'SELECT content FROM purama_ai.creator_agent_chats WHERE id = $1', [CHAT_ID],
      )).rows, [{ content: 'OWNER_A_PRIVATE_CHAT' }]);
      await db.query(
        "INSERT INTO purama_ai.creator_agent_runs (id, user_id, agent_id, trigger) VALUES ($1, $2, $3, 'manual')",
        [NEW_HISTORY_ID, USER_A, PRIVATE_A],
      );
      await db.query(
        "INSERT INTO purama_ai.creator_agent_chats (id, user_id, agent_id, session_id, role, content) VALUES ($1, $2, $3, $4, 'user', 'Own content')",
        [NEW_CHAT_ID, USER_A, PRIVATE_A, SESSION_ID],
      );
      assert.deepEqual((await db.query(
        "UPDATE purama_ai.creator_agent_runs SET status = 'success' WHERE id = $1 RETURNING status", [NEW_HISTORY_ID],
      )).rows, [{ status: 'success' }]);
      assert.deepEqual((await db.query(
        "UPDATE purama_ai.creator_agent_chats SET content = 'Updated own content' WHERE id = $1 RETURNING content", [NEW_CHAT_ID],
      )).rows, [{ content: 'Updated own content' }]);
      for (const [table, id] of [['creator_agent_runs', NEW_HISTORY_ID], ['creator_agent_chats', NEW_CHAT_ID]]) {
        assert.deepEqual((await db.query(
          'DELETE FROM purama_ai.' + table + ' WHERE id = $1 RETURNING id', [id],
        )).rows, [{ id }]);
      }
    });

    await sqlCase('browser users cannot create, promote or edit official templates', async () => {
      await identity('authenticated', USER_A);
      await expectSqlState(
        "INSERT INTO purama_ai.creator_agents (id, user_id, name, slug, system_prompt, is_template) VALUES ($1, $2, 'Fake official', 'fake-official', 'Prompt', true)",
        [OWN_NEW_ID, USER_A], '42501',
      );
      await expectSqlState(
        'UPDATE purama_ai.creator_agents SET is_template = true WHERE id = $1', [PRIVATE_A], '42501',
      );
      assert.deepEqual((await db.query(
        "UPDATE purama_ai.creator_agents SET name = 'Changed global official' WHERE id = $1 RETURNING id", [officialId],
      )).rows, []);
      assert.deepEqual((await db.query(
        "UPDATE purama_ai.creator_agents SET name = 'Ordinary owned model' WHERE id = $1 RETURNING id, is_template", [OWNED_OFFICIAL],
      )).rows, [{ id: OWNED_OFFICIAL, is_template: false }]);
    });

    await sqlCase('inactive publication is absent from the public RPC and cannot be newly copied', async () => {
      await identity('authenticated', USER_A);
      await db.query('UPDATE purama_ai.creator_agents SET is_active = false WHERE id = $1', [PUBLIC_A]);
      await identity('anon');
      assert.deepEqual((await db.query(
        'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A],
      )).rows, []);
      await identity('authenticated', USER_B);
      await expectSqlState(
        CLONE_SQL, [PUBLIC_A, COPY_ID, USER_B], 'P0002', /Model unavailable/,
      );
    });

    await sqlCase('withdrawn or private publications are absent and cannot be newly copied', async () => {
      await identity('authenticated', USER_A);
      await db.query('UPDATE purama_ai.creator_agents SET is_public = false WHERE id = $1', [PUBLIC_A]);
      for (const id of [PUBLIC_A, PRIVATE_A]) {
        await identity('anon');
        assert.deepEqual((await db.query(
          'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [id],
        )).rows, []);
        await identity('authenticated', USER_B);
        await expectSqlState(
          CLONE_SQL, [id, COPY_ID, USER_B], 'P0002',
        );
      }
    });

    await sqlCase('copy belongs to auth.uid(), is private and clears scheduling, KARTA and execution history', async () => {
      await identity('authenticated', USER_B);
      const copy = await clone();
      assert.equal(copy.id, COPY_ID);
      assert.equal(copy.user_id, USER_B);
      assert.equal(copy.cloned_from, PUBLIC_A);
      assert.equal(copy.slug, 'copy-' + COPY_ID);
      assert.equal(copy.name, 'Published model');
      assert.equal(copy.system_prompt, 'Reusable prompt from user A');
      assert.equal(copy.model, 'test-model');
      assert.deepEqual(copy.tools_enabled, ['web_search']);
      assert.equal(copy.is_active, true);
      assert.equal(copy.is_public, false);
      assert.equal(copy.is_template, false);
      assert.equal(copy.schedule_enabled, false);
      assert.equal(copy.schedule_cron, null);
      assert.equal(copy.schedule_input, null);
      assert.equal(copy.last_scheduled_run, null);
      assert.equal(copy.karta_enabled, false);
      assert.equal(copy.total_runs, 0);
      assert.equal(copy.total_tokens, 0);
      assert.equal(copy.avg_rating, null);
      assert.deepEqual((await db.query(
        'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [COPY_ID],
      )).rows, []);
      await identity('service_role');
      for (const table of ['creator_agent_runs', 'creator_agent_chats']) {
        assert.equal((await db.query(
          'SELECT count(*)::int AS count FROM purama_ai.' + table + ' WHERE agent_id = $1', [COPY_ID],
        )).rows[0].count, 0);
        assert.equal((await db.query(
          'SELECT count(*)::int AS count FROM purama_ai.' + table + ' WHERE agent_id = $1', [PUBLIC_A],
        )).rows[0].count, 1, 'The source history remains intact');
      }
      const original = (await db.query(
        'SELECT schedule_enabled, karta_enabled, total_runs FROM purama_ai.creator_agents WHERE id = $1', [PUBLIC_A],
      )).rows[0];
      assert.deepEqual(original, { schedule_enabled: true, karta_enabled: true, total_runs: 42 });
    });

    await sqlCase('official templates can be copied but the resulting copy has no official status', async () => {
      await identity('authenticated', USER_B);
      const copy = await clone(officialId);
      assert.equal(copy.user_id, USER_B);
      assert.equal(copy.is_template, false);
      assert.equal(copy.is_public, false);
      assert.equal(copy.cloned_from, officialId);
    });

    await sqlCase('replaying the same copy UUID returns the same row without overwriting personal edits', async () => {
      await identity('authenticated', USER_B);
      const first = await clone();
      await db.query("UPDATE purama_ai.creator_agents SET name = 'My edited copy' WHERE id = $1", [COPY_ID]);
      const replay = await clone();
      assert.equal(replay.id, first.id);
      assert.equal(replay.name, 'My edited copy');
      assert.equal((await db.query(
        'SELECT count(*)::int AS count FROM purama_ai.creator_agents WHERE user_id = $1 AND cloned_from = $2',
        [USER_B, PUBLIC_A],
      )).rows[0].count, 1);
    });

    await sqlCase('two distinct copy UUIDs intentionally produce two private copies', async () => {
      await identity('authenticated', USER_B);
      const first = await clone(PUBLIC_A, COPY_ID);
      const second = await clone(PUBLIC_A, SECOND_COPY_ID);
      assert.notEqual(first.id, second.id);
      assert.equal((await db.query(
        'SELECT count(*)::int AS count FROM purama_ai.creator_agents WHERE user_id = $1 AND cloned_from = $2',
        [USER_B, PUBLIC_A],
      )).rows[0].count, 2);
    });

    await sqlCase('deleting a source preserves another user’s private copy and its retry identity', async () => {
      await identity('authenticated', USER_B);
      await clone();
      await identity('authenticated', USER_A);
      assert.deepEqual((await db.query(
        'DELETE FROM purama_ai.creator_agents WHERE id = $1 RETURNING id', [PUBLIC_A],
      )).rows, [{ id: PUBLIC_A }]);
      await identity('authenticated', USER_B);
      const existing = await clone();
      assert.equal(existing.id, COPY_ID);
      assert.equal(existing.user_id, USER_B);
      assert.equal(existing.cloned_from, PUBLIC_A);
      assert.equal(existing.is_public, false);
      assert.equal(existing.system_prompt, 'Reusable prompt from user A');
      assert.deepEqual((await db.query(
        'SELECT * FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A],
      )).rows, []);
      await expectSqlState(
        CLONE_SQL, [PUBLIC_A, SECOND_COPY_ID, USER_B], 'P0002',
      );
    });

    await sqlCase('deleting the source account does not block deletion or destroy another user’s copy', async () => {
      await identity('authenticated', USER_B);
      await clone();
      await db.exec('RESET ROLE');
      assert.deepEqual((await db.query(
        'DELETE FROM auth.users WHERE id = $1 RETURNING id', [USER_A],
      )).rows, [{ id: USER_A }]);
      assert.deepEqual((await db.query(
        'SELECT id FROM purama_ai.creator_agents WHERE user_id = $1', [USER_A],
      )).rows, []);
      await identity('authenticated', USER_B);
      const existing = await clone();
      assert.equal(existing.id, COPY_ID);
      assert.equal(existing.user_id, USER_B);
      assert.equal(existing.cloned_from, PUBLIC_A);
      assert.equal(existing.is_template, false);
      assert.equal(existing.schedule_enabled, false);
      assert.equal(existing.karta_enabled, false);
    });

    await sqlCase('a requested copy UUID belonging to another user is denied and unchanged', async () => {
      await identity('authenticated', USER_B);
      await expectSqlState(
        CLONE_SQL, [PUBLIC_A, FOREIGN_COPY_ID, USER_B], '42501', /Copy request unavailable/,
      );
      assert.deepEqual((await db.query(
        'SELECT * FROM purama_ai.creator_agents WHERE id = $1', [FOREIGN_COPY_ID],
      )).rows, []);
      await identity('service_role');
      assert.deepEqual((await db.query(
        'SELECT user_id, cloned_from, name FROM purama_ai.creator_agents WHERE id = $1', [FOREIGN_COPY_ID],
      )).rows, [{ user_id: USER_A, cloned_from: PUBLIC_A, name: 'A different account’s existing copy' }]);
    });

    await sqlCase('a replay UUID cannot be reused for a different source', async () => {
      await identity('authenticated', USER_B);
      await clone();
      await expectSqlState(
        CLONE_SQL, [OTHER_SOURCE, COPY_ID, USER_B], '42501',
      );
      assert.deepEqual((await db.query(
        'SELECT id, cloned_from FROM purama_ai.creator_agents WHERE id = $1', [COPY_ID],
      )).rows, [{ id: COPY_ID, cloned_from: PUBLIC_A }]);
    });

    await sqlCase('authenticated role without a JWT subject cannot copy or see private rows', async () => {
      await identity('authenticated');
      assert.equal((await db.query('SELECT auth.uid() AS uid')).rows[0].uid, null);
      assert.deepEqual((await db.query('SELECT * FROM purama_ai.creator_agents')).rows, []);
      await expectSqlState(
        CLONE_SQL, [PUBLIC_A, COPY_ID, USER_B], '42501', /Authentication changed or required/,
      );
    });

    await sqlCase('null/equal IDs and a fourth caller-supplied owner argument are rejected', async () => {
      await identity('authenticated', USER_B);
      for (const ids of [[null, COPY_ID], [PUBLIC_A, null], [PUBLIC_A, PUBLIC_A]]) {
        await expectSqlState(
          CLONE_SQL, [...ids, USER_B], '22023',
        );
      }
      await expectSqlState(
        'SELECT * FROM purama_ai.clone_public_creator_model($1::uuid, $2::uuid, $3::uuid, $4::uuid)',
        [PUBLIC_A, COPY_ID, USER_B, USER_A], '42883',
      );
    });

    await sqlCase('a session change from expected A to authenticated B is refused before any copy insert', async () => {
      // A sequence increment survives a statement/savepoint rollback. Unlike
      // checking only the final row count, this detects an INSERT attempted
      // before a late account-mismatch exception.
      await db.exec([
        'CREATE SEQUENCE purama_ai.test_clone_insert_attempt;',
        "CREATE FUNCTION purama_ai.test_record_clone_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ BEGIN PERFORM pg_catalog.nextval('purama_ai.test_clone_insert_attempt'::regclass); RETURN NEW; END; $$;",
        'CREATE TRIGGER test_clone_insert_attempt BEFORE INSERT ON purama_ai.creator_agents FOR EACH ROW EXECUTE FUNCTION purama_ai.test_record_clone_insert();',
      ].join('\n'));
      await identity('authenticated', USER_A);
      const expectedUserId = USER_A;
      await identity('authenticated', USER_B);
      for (const sourceId of [PUBLIC_A, PRIVATE_A, null]) {
        await expectSqlState(CLONE_SQL, [sourceId, COPY_ID, expectedUserId], '42501');
      }
      await db.exec('RESET ROLE');
      assert.equal((await db.query(
        'SELECT is_called FROM purama_ai.test_clone_insert_attempt',
      )).rows[0].is_called, false, 'The account check must precede any INSERT attempt');
      assert.deepEqual((await db.query(
        'SELECT id, user_id FROM purama_ai.creator_agents WHERE id = $1', [COPY_ID],
      )).rows, [], 'No account receives a copy after a stale-session request');
    });

    await sqlCase('a null expected account is refused even with a valid authenticated identity', async () => {
      await identity('authenticated', USER_B);
      await expectSqlState(CLONE_SQL, [PUBLIC_A, COPY_ID, null], '42501');
      await db.exec('RESET ROLE');
      assert.deepEqual((await db.query(
        'SELECT id FROM purama_ai.creator_agents WHERE id = $1', [COPY_ID],
      )).rows, []);
    });

    await sqlCase('matching expected B and authenticated B succeeds with B as the server-derived owner', async () => {
      await identity('authenticated', USER_B);
      const copy = await clone(PUBLIC_A, COPY_ID, USER_B);
      assert.equal(copy.id, COPY_ID);
      assert.equal(copy.user_id, USER_B);
      assert.equal(copy.cloned_from, PUBLIC_A);
      assert.equal(copy.is_public, false);
      await identity('service_role');
      assert.deepEqual((await db.query(
        'SELECT user_id FROM purama_ai.creator_agents WHERE id = $1', [PUBLIC_A],
      )).rows, [{ user_id: USER_A }], 'The source owner is not reassigned');
    });

    await sqlCase('a stale expected account also blocks replay of an already-existing copy', async () => {
      await identity('authenticated', USER_B);
      await clone(PUBLIC_A, COPY_ID, USER_B);
      await expectSqlState(CLONE_SQL, [PUBLIC_A, COPY_ID, USER_A], '42501');
      assert.deepEqual((await db.query(
        'SELECT id, user_id, cloned_from FROM purama_ai.creator_agents WHERE id = $1', [COPY_ID],
      )).rows, [{ id: COPY_ID, user_id: USER_B, cloned_from: PUBLIC_A }]);
    });

    await sqlCase('the inherited two-argument overload is removed and cannot bypass the expected-account check', async () => {
      assert.equal((await db.query(
        "SELECT pg_catalog.to_regprocedure('purama_ai.clone_public_creator_model(uuid,uuid)') AS legacy",
      )).rows[0].legacy, null);
      await identity('authenticated', USER_B);
      await expectSqlState(
        'SELECT * FROM purama_ai.clone_public_creator_model($1::uuid, $2::uuid)',
        [PUBLIC_A, COPY_ID], '42883',
      );
    });

    await sqlCase('TRUNCATE is denied for anonymous/authenticated roles on models, runs and chats', async () => {
      for (const role of ['anon', 'authenticated']) {
        await identity(role, role === 'authenticated' ? USER_A : null);
        for (const table of TABLES) {
          const privilege = await db.query(
            "SELECT has_table_privilege($1::name, $2::text, 'TRUNCATE') AS allowed",
            [role, 'purama_ai.' + table],
          );
          assert.equal(privilege.rows[0].allowed, false, role + ' must not truncate ' + table);
          await expectSqlState('TRUNCATE TABLE purama_ai.' + table + ' CASCADE', [], '42501');
        }
      }
    });

    await sqlCase('function execution grants and fixed search paths are effective in the database catalog', async () => {
      const { rows } = await db.query(
        "SELECT p.proname, p.prosecdef, p.proconfig, p.pronargs, p.pronargdefaults FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'purama_ai' AND p.proname IN ('public_creator_models', 'clone_public_creator_model') ORDER BY p.proname",
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.prosecdef, true);
        assert.ok(row.proconfig.includes('search_path=""'));
        assert.equal(row.pronargs, row.proname === 'clone_public_creator_model' ? 3 : 2);
        if (row.proname === 'clone_public_creator_model') assert.equal(row.pronargdefaults, 0);
      }
      const functions = [
        ['purama_ai.public_creator_models(uuid,text)', true],
        ['purama_ai.clone_public_creator_model(uuid,uuid,uuid)', false],
      ];
      for (const [signature, anonAllowed] of functions) {
        for (const [role, allowed] of [['anon', anonAllowed], ['authenticated', true]]) {
          assert.equal((await db.query(
            "SELECT has_function_privilege($1::name, $2::text, 'EXECUTE') AS allowed", [role, signature],
          )).rows[0].allowed, allowed);
        }
      }
      assert.deepEqual((await db.query(
        "SELECT p.proname FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a WHERE n.nspname = 'purama_ai' AND p.proname IN ('public_creator_models', 'clone_public_creator_model') AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'",
      )).rows, [], 'No new RPC is executable by PUBLIC');
      for (const table of TABLES) {
        for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal((await db.query(
            'SELECT has_table_privilege($1::name, $2::text, $3::text) AS allowed',
            ['authenticated', 'purama_ai.' + table, operation],
          )).rows[0].allowed, true);
          assert.equal((await db.query(
            'SELECT has_table_privilege($1::name, $2::text, $3::text) AS allowed',
            ['anon', 'purama_ai.' + table, operation],
          )).rows[0].allowed, false);
          assert.equal((await db.query(
            'SELECT has_table_privilege($1::name, $2::text, $3::text) AS allowed',
            ['service_role', 'purama_ai.' + table, operation],
          )).rows[0].allowed, true);
        }
      }
    });

    await sqlCase('caller search_path cannot substitute a shadow model table', async () => {
      await db.exec([
        'CREATE SCHEMA hostile;',
        'CREATE TABLE hostile.creator_agents (LIKE purama_ai.creator_agents INCLUDING ALL);',
        'GRANT USAGE ON SCHEMA hostile TO authenticated;',
        'GRANT SELECT ON hostile.creator_agents TO authenticated;',
      ].join('\n'));
      await db.query(
        "INSERT INTO hostile.creator_agents (id, user_id, name, slug, system_prompt, is_public) VALUES ($1, $2, 'Shadow content', 'shadow', 'Wrong prompt', true)",
        [PUBLIC_A, USER_B],
      );
      await identity('authenticated', USER_B);
      await db.exec('SET LOCAL search_path = hostile, public');
      assert.deepEqual((await db.query(
        'SELECT name FROM purama_ai.public_creator_models($1::uuid)', [PUBLIC_A],
      )).rows, [{ name: 'Published model' }]);
      const copy = await clone();
      assert.equal(copy.name, 'Published model');
      assert.equal(copy.system_prompt, 'Reusable prompt from user A');
    });
  } finally {
    await db.close();
  }
});
