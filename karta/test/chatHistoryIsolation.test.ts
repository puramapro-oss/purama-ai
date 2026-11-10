import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL(
  '../../supabase/migrations/20261102001000_chat_history_owner_only.sql', import.meta.url,
), 'utf8');
const historical = readFileSync(new URL(
  '../../supabase/migrations/20260123005730_0e85ec11-21c9-4170-9768-b446b0c34c27.sql', import.meta.url,
), 'utf8');
// Exercise the actual historical table definitions and policies, with broad
// grants like the existing schema migrations. No live database is contacted.
const definitions = historical.slice(historical.indexOf('-- Table pour les conversations'),
  historical.indexOf('-- Enable RLS'));
const policies = historical.slice(historical.indexOf('-- Conversations:'), historical.indexOf('-- Indexes'));
type Schema = 'public' | 'purama_ai';
type DbRole = 'anon' | 'authenticated' | 'service_role';
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const ownConversation = '00000000-0000-4000-8000-000000000011';
const otherConversation = '00000000-0000-4000-8000-000000000012';
const anonymousConversation = '00000000-0000-4000-8000-000000000013';

async function fixture(schemas: readonly Schema[]) {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        $$ SELECT nullif(current_setting('test.user_id', true), '')::uuid $$;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    `);
    for (const schema of schemas) {
      await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema};
        GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated, service_role;`);
      await db.exec((definitions + policies).replaceAll('public.chat_', `${schema}.chat_`));
      await db.exec(`ALTER TABLE ${schema}.chat_conversations ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${schema}.chat_messages ENABLE ROW LEVEL SECURITY;
        GRANT ALL ON ${schema}.chat_conversations, ${schema}.chat_messages
          TO PUBLIC, anon, authenticated, service_role;`);
      await db.query(`INSERT INTO ${schema}.chat_conversations (id, user_id, session_id) VALUES
        ($1, $2, 'shared-session'), ($3, $4, 'shared-session'), ($5, NULL, 'shared-session')`,
      [ownConversation, owner, otherConversation, other, anonymousConversation]);
      await db.query(`INSERT INTO ${schema}.chat_messages (conversation_id, role, content) VALUES
        ($1, 'user', 'seed-owner'), ($2, 'user', 'seed-other'), ($3, 'user', 'seed-anonymous')`,
      [ownConversation, otherConversation, anonymousConversation]);
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function asRole<T>(db: PGlite, role: DbRole, userId: string | null, work: () => Promise<T>) {
  await db.query("SELECT set_config('test.user_id', $1, false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); }
  finally { await db.exec('RESET ROLE'); }
}

async function accessSnapshot(db: PGlite) {
  return (await db.query(`
    SELECT n.nspname, c.relname, c.relrowsecurity, c.relacl::text,
      p.polname, p.polcmd::text, p.polpermissive, p.polroles::text,
      pg_get_expr(p.polqual, p.polrelid) AS qual,
      pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_policy p ON p.polrelid = c.oid
    WHERE n.nspname IN ('public', 'purama_ai')
      AND c.relname IN ('chat_conversations', 'chat_messages')
    ORDER BY n.nspname, c.relname, p.polname
  `)).rows;
}

describe.each([
  { label: 'public only', schemas: ['public'] as const },
  { label: 'purama_ai only', schemas: ['purama_ai'] as const },
  { label: 'both schemas', schemas: ['public', 'purama_ai'] as const },
])('stored chat ownership: $label', ({ schemas }) => {
  let db: PGlite;
  beforeAll(async () => { db = await fixture(schemas); await db.exec(migration); });
  afterAll(async () => { await db?.close(); });

  it('preserves historical anonymous and owned rows', async () => {
    for (const schema of schemas) {
      expect((await db.query(`SELECT content FROM ${schema}.chat_messages
        WHERE content LIKE 'seed-%' ORDER BY content`)).rows).toEqual([
        { content: 'seed-anonymous' }, { content: 'seed-other' }, { content: 'seed-owner' },
      ]);
      expect((await db.query(`SELECT user_id FROM ${schema}.chat_conversations WHERE id = $1`,
        [anonymousConversation])).rows).toEqual([{ user_id: null }]);
    }
  });

  it('denies anonymous reads and inserts even with a known conversation and session', async () => {
    await asRole(db, 'anon', null, async () => {
      for (const schema of schemas) {
        for (const table of ['chat_conversations', 'chat_messages']) {
          await expect(db.query(`SELECT * FROM ${schema}.${table}`)).rejects.toThrow(/permission denied/);
        }
        await expect(db.query(`INSERT INTO ${schema}.chat_conversations(user_id, session_id)
          VALUES ($1, 'shared-session')`, [owner])).rejects.toThrow(/permission denied/);
        await expect(db.query(`INSERT INTO ${schema}.chat_messages(conversation_id, role, content)
          VALUES ($1, 'user', 'anonymous write')`, [ownConversation])).rejects.toThrow(/permission denied/);
      }
    });
  });

  it('lets each authenticated user read only their own history', async () => {
    for (const [userId, expected] of [[owner, 'seed-owner'], [other, 'seed-other']]) {
      await asRole(db, 'authenticated', userId, async () => {
        for (const schema of schemas) {
          expect((await db.query(`SELECT content FROM ${schema}.chat_messages
            WHERE content LIKE 'seed-%'`)).rows).toEqual([{ content: expected }]);
          expect((await db.query(`SELECT id FROM ${schema}.chat_conversations
            WHERE id = $1`, [anonymousConversation])).rows).toEqual([]);
        }
      });
    }
  });

  it('preserves creation, RETURNING, user/assistant messages and status updates for the owner', async () => {
    await asRole(db, 'authenticated', owner, async () => {
      for (const schema of schemas) {
        const created = await db.query<{ id: string }>(`INSERT INTO ${schema}.chat_conversations
          (user_id, session_id) VALUES ($1, 'new-session') RETURNING id`, [owner]);
        expect(created.rows).toHaveLength(1);
        for (const role of ['user', 'assistant']) {
          await db.query(`INSERT INTO ${schema}.chat_messages(conversation_id, role, content)
            VALUES ($1, $2, 'owned new text')`, [created.rows[0].id, role]);
        }
        expect((await db.query(`UPDATE ${schema}.chat_conversations SET status = 'closed'
          WHERE id = $1 RETURNING status`, [created.rows[0].id])).rows).toEqual([{ status: 'closed' }]);
      }
    });
  });

  it('denies cross-user and anonymous conversation creation or message insertion', async () => {
    await asRole(db, 'authenticated', owner, async () => {
      for (const schema of schemas) {
        for (const userId of [other, null]) {
          await expect(db.query(`INSERT INTO ${schema}.chat_conversations(user_id, session_id)
            VALUES ($1, 'shared-session')`, [userId])).rejects.toThrow(/row-level security/);
        }
        for (const id of [otherConversation, anonymousConversation]) {
          await expect(db.query(`INSERT INTO ${schema}.chat_messages(conversation_id, role, content)
            VALUES ($1, 'assistant', 'foreign write')`, [id])).rejects.toThrow(/row-level security/);
        }
      }
    });
  });

  it('rejects system messages and ownership transfers by authenticated clients', async () => {
    await asRole(db, 'authenticated', owner, async () => {
      for (const schema of schemas) {
        await expect(db.query(`INSERT INTO ${schema}.chat_messages(conversation_id, role, content)
          VALUES ($1, 'system', 'not model context')`, [ownConversation])).rejects.toThrow(/row-level security/);
        for (const userId of [other, null]) {
          await expect(db.query(`UPDATE ${schema}.chat_conversations SET user_id = $1 WHERE id = $2`,
            [userId, ownConversation])).rejects.toThrow(/row-level security/);
        }
        expect((await db.query(`UPDATE ${schema}.chat_conversations SET status = 'changed'
          WHERE id = $1 RETURNING id`, [otherConversation])).rows).toEqual([]);
      }
    });
  });

  it('does not grant message editing, deletion or RLS-bypassing TRUNCATE to clients', async () => {
    await asRole(db, 'authenticated', owner, async () => {
      for (const schema of schemas) {
        for (const sql of [
          `UPDATE ${schema}.chat_messages SET content = 'changed'`,
          `DELETE FROM ${schema}.chat_messages`,
          `DELETE FROM ${schema}.chat_conversations`,
          `TRUNCATE ${schema}.chat_messages`,
          `TRUNCATE ${schema}.chat_conversations CASCADE`,
        ]) await expect(db.exec(sql)).rejects.toThrow(/permission denied/);
      }
    });
  });

  it('does not authorize an authenticated role without a user identity', async () => {
    await asRole(db, 'authenticated', null, async () => {
      for (const schema of schemas) {
        expect((await db.query(`SELECT * FROM ${schema}.chat_messages`)).rows).toEqual([]);
        await expect(db.query(`INSERT INTO ${schema}.chat_conversations(user_id, session_id)
          VALUES (NULL, 'shared-session')`)).rejects.toThrow(/row-level security/);
      }
    });
  });

  it('preserves administrative read/write/delete rights, including anonymous historical rows', async () => {
    await asRole(db, 'service_role', null, async () => {
      for (const schema of schemas) {
        expect((await db.query(`SELECT content FROM ${schema}.chat_messages
          WHERE conversation_id = $1`, [anonymousConversation])).rows).toEqual([{ content: 'seed-anonymous' }]);
        const result = await db.query<{ id: string }>(`INSERT INTO ${schema}.chat_messages
          (conversation_id, role, content) VALUES ($1, 'system', 'admin record') RETURNING id`,
        [anonymousConversation]);
        await db.query(`UPDATE ${schema}.chat_messages SET content = 'admin updated' WHERE id = $1`,
          [result.rows[0].id]);
        await db.query(`DELETE FROM ${schema}.chat_messages WHERE id = $1`, [result.rows[0].id]);
        const conversation = await db.query<{ id: string }>(`INSERT INTO ${schema}.chat_conversations
          (user_id, session_id) VALUES (NULL, 'administrative') RETURNING id`);
        await db.query(`UPDATE ${schema}.chat_conversations SET status = 'closed' WHERE id = $1`,
          [conversation.rows[0].id]);
        await db.query(`DELETE FROM ${schema}.chat_conversations WHERE id = $1`, [conversation.rows[0].id]);
      }
    });
  });

  it('can be applied twice without changing the resulting policies or privileges', async () => {
    const before = await accessSnapshot(db);
    await db.exec(migration);
    expect(await accessSnapshot(db)).toEqual(before);
  });
});

describe('migration preflight refuses an unreviewed schema', () => {
  const cases: Array<{ label: string; setup: string; error: RegExp }> = [
    { label: 'only conversations remain', setup: 'DROP TABLE purama_ai.chat_messages', error: /Incomplete chat history schema/ },
    { label: 'only messages remain', setup: 'DROP TABLE purama_ai.chat_conversations CASCADE', error: /Incomplete chat history schema/ },
    { label: 'an extra permissive conversation policy exists',
      setup: 'CREATE POLICY unexpected ON purama_ai.chat_conversations FOR SELECT USING (true)',
      error: /Unexpected chat_conversations policies/ },
    { label: 'an extra permissive message policy exists',
      setup: 'CREATE POLICY unexpected ON purama_ai.chat_messages FOR ALL USING (true) WITH CHECK (true)',
      error: /Unexpected chat_messages policies/ },
    { label: 'a required policy is missing',
      setup: 'DROP POLICY "Anyone can insert messages" ON purama_ai.chat_messages',
      error: /Unexpected chat_messages policies/ },
    { label: 'a known name has an unexpected policy command',
      setup: `DROP POLICY "Anyone can insert messages" ON purama_ai.chat_messages;
        CREATE POLICY "Anyone can insert messages" ON purama_ai.chat_messages FOR ALL USING (true) WITH CHECK (true)`,
      error: /Unexpected chat_messages policies/ },
    { label: 'a known name is unexpectedly restrictive',
      setup: `DROP POLICY "Anyone can insert messages" ON purama_ai.chat_messages;
        CREATE POLICY "Anyone can insert messages" ON purama_ai.chat_messages AS RESTRICTIVE FOR INSERT WITH CHECK (true)`,
      error: /Unexpected chat_messages policies/ },
    { label: 'a table was replaced by a view',
      setup: 'DROP TABLE purama_ai.chat_messages; CREATE VIEW purama_ai.chat_messages AS SELECT 1 AS id',
      error: /Unexpected chat history relation type/ },
  ];

  it.each(cases)('rolls back both schemas when $label', async ({ setup, error }) => {
    const db = await fixture(['public', 'purama_ai']);
    try {
      await db.exec(setup);
      const before = await accessSnapshot(db);
      await expect(db.exec(migration)).rejects.toThrow(error);
      await db.exec('ROLLBACK');
      expect(await accessSnapshot(db)).toEqual(before);
    } finally { await db.close(); }
  });

  it('refuses to report success when neither schema contains chat history', async () => {
    const db = await fixture([]);
    try {
      await expect(db.exec(migration)).rejects.toThrow(/No chat history tables found/);
      await db.exec('ROLLBACK');
    } finally { await db.close(); }
  });
});
