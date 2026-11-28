import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, beforeEach, test } from 'node:test';
import { parseSmaranaApplyResult, parseSmaranaPullResult, parseSmaranaMutation } from '../../shared/smarana.ts';

const requireKarta = createRequire(new URL('../../karta/package.json', import.meta.url));
const { PGlite } = requireKarta('@electric-sql/pglite');
const migration = await readFile(new URL('../../supabase/migrations/20261123180000_smarana_replication.sql', import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const stamp = '2026-11-23T10:20:30.123Z';
const snapshot = (overrides = {}) => ({ title: 'Conversation privée', draft: 'Brouillon conservé', messages: [{ id: randomUUID(), role: 'user', content: 'Bonjour 🧠', state: 'complete', createdAt: stamp }], ...overrides });
const mutation = (overrides = {}) => ({ schemaVersion: 1, ownerId: owner, resourceId: randomUUID(), mutationId: randomUUID(), baseRevision: 0, tombstone: false, payload: snapshot(), ...overrides });
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
  `);
  await db.exec(migration);
  await db.exec(migration);
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('RESET ROLE; TRUNCATE auth.users CASCADE;');
  await db.query('INSERT INTO auth.users(id) VALUES($1),($2)', [owner, other]);
});
async function asRole(role, userId, work) {
  await db.query("SELECT set_config('test.user_id',$1,false)", [userId ?? '']);
  await db.exec(`SET ROLE ${role}`);
  try { return await work(); } finally { await db.exec('RESET ROLE'); }
}
async function apply(input, expected = input.ownerId) {
  const value = (await db.query('SELECT purama_ai.smarana_apply($1,$2::jsonb) AS value', [expected, JSON.stringify(input)])).rows[0].value;
  return parseSmaranaApplyResult(value);
}
async function pull(expected = owner, cursor = '0', limit = 20) {
  const value = (await db.query('SELECT purama_ai.smarana_pull($1,$2,$3) AS value', [expected, cursor, limit])).rows[0].value;
  return parseSmaranaPullResult(value);
}
async function tableCount(name) { return Number((await db.query(`SELECT count(*) AS count FROM purama_ai.${name}`)).rows[0].count); }

test('stores one canonical conversation and pulls the same content through the authenticated account', async () => {
  const input = mutation();
  await asRole('authenticated', owner, async () => {
    const receipt = await apply(input);
    assert.deepEqual({ ...receipt, updatedAt: stamp }, { status: 'applied', ownerId: owner, resourceId: input.resourceId,
      mutationId: input.mutationId, baseRevision: 0, revision: 1, cursor: '1', updatedAt: stamp, replayed: false });
    const page = await pull();
    assert.equal(page.cursor, '1'); assert.equal(page.hasMore, false); assert.equal(page.records.length, 1);
    assert.deepEqual(page.records[0].payload, input.payload);
    assert.deepEqual(await pull(owner, page.cursor), { ownerId: owner, records: [], cursor: '1', hasMore: false });
  });
});

test('lost acknowledgements replay the exact durable receipt without duplicating data or advancing the cursor', async () => {
  const input = mutation();
  await asRole('authenticated', owner, async () => {
    const first = await apply(input);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    assert.deepEqual(await apply(reordered), { ...first, replayed: true });
    assert.equal((await pull()).cursor, '1');
  });
  assert.equal(await tableCount('smarana_records'), 1);
  assert.equal(await tableCount('smarana_mutations'), 1);
});

test('normalizes an omitted draft and integral JSON numbers before server-side fingerprinting', async () => {
  const input = mutation({ payload: snapshot({ draft: '' }) });
  const { draft: _draft, ...withoutDraft } = input.payload;
  await asRole('authenticated', owner, async () => {
    const first = await apply({ ...input, payload: withoutDraft });
    assert.deepEqual(await apply(input), { ...first, replayed: true });
    const json = JSON.stringify(input).replace('"schemaVersion":1', '"schemaVersion":1.0').replace('"baseRevision":0', '"baseRevision":0.0');
    const next = (await db.query('SELECT purama_ai.smarana_apply($1,$2::jsonb) AS value', [owner, json])).rows[0].value;
    assert.deepEqual(next, { ...first, replayed: true });
  });
});

test('a reused mutation ID with different content is a conflict, never a second write', async () => {
  const input = mutation();
  await asRole('authenticated', owner, async () => {
    await apply(input);
    const conflict = await apply({ ...input, payload: { ...input.payload, draft: 'Different' } });
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.reason, 'mutation_reused');
    assert.deepEqual(conflict.current.payload, input.payload);
    assert.equal((await pull()).cursor, '1');
  });
  assert.equal(await tableCount('smarana_mutations'), 1);
});

test('stale revisions preserve both the submitted draft and the exact remote conflict on retries', async () => {
  const input = mutation();
  const stale = mutation({ resourceId: input.resourceId, payload: snapshot({ draft: 'My offline draft' }) });
  await asRole('authenticated', owner, async () => {
    await apply(input);
    const conflict = await apply(stale);
    assert.equal(conflict.reason, 'revision'); assert.deepEqual(conflict.current.payload, input.payload);
    await apply(mutation({ resourceId: input.resourceId, baseRevision: 1, payload: snapshot({ draft: 'Remote revision two' }) }));
    assert.deepEqual(await apply(stale), { ...conflict, replayed: true });
    assert.equal(stale.payload.draft, 'My offline draft');
    assert.equal((await pull()).records[0].revision, 2);
  });
});

test('a rejected future revision remains rejected even when the record later reaches that revision', async () => {
  const input = mutation();
  const future = mutation({ resourceId: input.resourceId, baseRevision: 1 });
  await asRole('authenticated', owner, async () => {
    const conflict = await apply(future);
    assert.equal(conflict.reason, 'revision'); assert.equal(conflict.current, null);
    await apply(input);
    assert.deepEqual(await apply(future), { ...conflict, replayed: true });
    assert.equal((await pull()).cursor, '1');
  });
});

test('tombstones are terminal, including old successful receipt replays and correctly based new writes', async () => {
  const input = mutation();
  await asRole('authenticated', owner, async () => {
    const created = await apply(input);
    const removed = mutation({ resourceId: input.resourceId, baseRevision: 1, tombstone: true, payload: null });
    const deletion = await apply(removed);
    assert.equal(deletion.revision, 2);
    assert.deepEqual(await apply(removed), { ...deletion, replayed: true });
    assert.deepEqual(await apply(input), { ...created, replayed: true });
    const late = await apply(mutation({ resourceId: input.resourceId, baseRevision: 2 }));
    assert.equal(late.reason, 'deleted'); assert.equal(late.current.tombstone, true);
    const page = await pull();
    assert.equal(page.cursor, '2'); assert.equal(page.records[0].payload, null); assert.equal(page.records[0].tombstone, true);
  });
});

test('deleting before first upload creates a terminal marker that blocks a late create', async () => {
  const input = mutation();
  await asRole('authenticated', owner, async () => {
    const deletion = await apply(mutation({ resourceId: input.resourceId, tombstone: true, payload: null }));
    assert.equal(deletion.revision, 1);
    assert.equal((await apply(input)).reason, 'deleted');
    assert.equal((await pull()).records[0].payload, null);
  });
});

test('identical resource and mutation IDs in two accounts remain fully isolated', async () => {
  const input = mutation();
  await asRole('authenticated', owner, () => apply(input));
  await asRole('authenticated', other, async () => {
    assert.equal((await pull(other)).records.length, 0);
    const second = await apply({ ...input, ownerId: other, payload: snapshot({ draft: 'Account B' }) });
    assert.equal(second.cursor, '1'); assert.equal(second.ownerId, other);
    const rows = (await db.query('SELECT owner_id,payload FROM purama_ai.smarana_records')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].owner_id, other); assert.equal(rows[0].payload.draft, 'Account B');
    await assert.rejects(() => apply(input), /SMARANA unavailable/);
    await assert.rejects(() => pull(owner), /SMARANA unavailable/);
    await assert.rejects(() => apply({ ...input, ownerId: other }, owner), /SMARANA unavailable/);
  });
  await asRole('authenticated', owner, async () => assert.deepEqual((await pull()).records[0].payload, input.payload));
});

test('blocks anonymous and service-role RPCs, absent sessions, and every direct write/ledger read', async () => {
  const input = mutation();
  for (const role of ['anon', 'service_role']) await asRole(role, owner, async () => {
    await assert.rejects(() => apply(input), /permission denied/);
    await assert.rejects(() => pull(), /permission denied/);
  });
  await asRole('authenticated', null, async () => {
    await assert.rejects(() => apply(input), /SMARANA unavailable/);
    await assert.rejects(() => pull(), /SMARANA unavailable/);
  });
  await asRole('authenticated', owner, async () => {
    for (const query of [
      'DELETE FROM purama_ai.smarana_records', 'UPDATE purama_ai.smarana_records SET tombstone=true',
      'TRUNCATE purama_ai.smarana_records', 'SELECT * FROM purama_ai.smarana_mutations',
      'SELECT * FROM purama_ai.smarana_owner_cursors',
      `INSERT INTO purama_ai.smarana_records(owner_id,resource_id,revision,cursor,tombstone,updated_at) VALUES('${owner}','${input.resourceId}',1,1,true,now())`,
    ]) await assert.rejects(() => db.query(query), /permission denied/);
  });
});

test('pages only current snapshots, with bounded limits and resumable ordered string cursors', async () => {
  const inputs = [mutation(), mutation(), mutation()];
  await asRole('authenticated', owner, async () => {
    for (const input of inputs) await apply(input);
    const first = await pull(owner, '0', 1);
    assert.equal(first.cursor, '1'); assert.equal(first.hasMore, true);
    await apply(mutation({ resourceId: inputs[0].resourceId, baseRevision: 1, payload: inputs[0].payload }));
    const second = await pull(owner, first.cursor, 2);
    assert.deepEqual(second.records.map(row => row.cursor), ['2', '3']); assert.equal(second.hasMore, true);
    const third = await pull(owner, second.cursor, 2);
    assert.deepEqual(third.records.map(row => row.cursor), ['4']); assert.equal(third.hasMore, false);
    assert.equal(third.records[0].resourceId, inputs[0].resourceId);
    for (const limit of [0, 21, null]) await assert.rejects(() => pull(owner, '0', limit), /SMARANA unavailable/);
    for (const cursor of ['01', '-1', '1.0', '9223372036854775808', '5']) await assert.rejects(() => pull(owner, cursor), /SMARANA unavailable/);
  });
});

test('rollback removes the snapshot, receipt and allocated cursor together', async () => {
  const input = mutation();
  await asRole('authenticated', owner, async () => {
    await db.exec('BEGIN');
    try { await apply(input); } finally { await db.exec('ROLLBACK'); }
    assert.equal((await pull()).records.length, 0);
    const retried = await apply(input);
    assert.equal(retried.cursor, '1'); assert.equal(retried.replayed, false);
  });
});

test('a receipt-storage failure cannot commit an unacknowledgeable document or consume its cursor', async () => {
  await db.exec('ALTER TABLE purama_ai.smarana_mutations ADD CONSTRAINT test_receipt_failure CHECK(false) NOT VALID');
  try { await asRole('authenticated', owner, async () => await assert.rejects(() => apply(mutation()), /SMARANA unavailable/)); }
  finally { await db.exec('ALTER TABLE purama_ai.smarana_mutations DROP CONSTRAINT test_receipt_failure'); }
  for (const table of ['smarana_records', 'smarana_mutations', 'smarana_owner_cursors']) assert.equal(await tableCount(table), 0);
});

test('retains large bigint cursors as exact decimal strings', async () => {
  const input = mutation();
  await asRole('authenticated', owner, () => apply(input));
  await db.query('UPDATE purama_ai.smarana_owner_cursors SET cursor = $1 WHERE owner_id = $2', ['9007199254740992', owner]);
  await asRole('authenticated', owner, async () => {
    const next = await apply(mutation());
    assert.equal(next.cursor, '9007199254740993');
    assert.equal((await pull(owner, '9007199254740992')).cursor, '9007199254740993');
  });
});

test('matches portable validation for malformed fields, dates, identities and Unicode limits', async () => {
  const input = mutation();
  const m = input.payload.messages[0];
  const invalid = [
    { ...input, unexpected: true }, { ...input, schemaVersion: 2 }, { ...input, baseRevision: -1 },
    { ...input, baseRevision: 0.5 }, { ...input, baseRevision: Number.MAX_SAFE_INTEGER },
    { ...input, tombstone: true }, { ...input, payload: null },
    { ...input, payload: snapshot({ title: '🧠'.repeat(257) }) },
    { ...input, payload: snapshot({ messages: [m, m] }) },
    ...[{ role: 'system' }, { state: 'pending' }, { content: '' }, { createdAt: '2026-02-30T10:20:30.123Z' },
      { createdAt: '0000-01-01T00:00:00.000Z' }, { content: '🧠'.repeat(65_536) + 'x' }, { extra: 'PRIVATE_SENTINEL' }]
      .map(change => ({ ...input, payload: snapshot({ messages: [{ ...m, ...change }] }) })),
  ];
  await asRole('authenticated', owner, async () => {
    for (const value of invalid) {
      assert.throws(() => parseSmaranaMutation(value));
      await assert.rejects(() => apply(value), error => error.message === 'SMARANA unavailable');
    }
    const valid = mutation({ payload: snapshot({ title: '🧠'.repeat(256), messages: [{ ...m, content: '🧠'.repeat(65_536) }] }) });
    parseSmaranaMutation(valid);
    assert.equal((await apply(valid)).status, 'applied');
  });
});

test('uses hardened function search paths and account deletion removes all records and receipts', async () => {
  const definitions = (await db.query(`SELECT proname,prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='purama_ai' AND proname IN ('smarana_apply','smarana_pull') ORDER BY proname`)).rows;
  assert.deepEqual(definitions, ['smarana_apply', 'smarana_pull'].map(proname => ({ proname, prosecdef: true, proconfig: ['search_path=pg_catalog'] })));
  await asRole('authenticated', owner, () => apply(mutation()));
  await db.query('DELETE FROM auth.users WHERE id=$1', [owner]);
  for (const table of ['smarana_records', 'smarana_mutations', 'smarana_owner_cursors']) assert.equal(await tableCount(table), 0);
});

test('reapplying the migration preserves data and the replay identity', async () => {
  const input = mutation();
  const first = await asRole('authenticated', owner, () => apply(input));
  await db.exec(migration);
  await asRole('authenticated', owner, async () => assert.deepEqual(await apply(input), { ...first, replayed: true }));
});
