import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { asRole, callRpc, createDb, seedUsers, USERS } from './db-harness.mjs';

// Real historical SQL state plus a migration-selector fixture. This proves that
// only the additive migration is needed, not a replay of an applied 021000.
// It does not execute the hosted Supabase CLI or establish native concurrency.
const migrations = new URL('../../supabase/migrations/', import.meta.url);
const oldMissionSql = await readFile(new URL('./fixtures/pr23-20261110021000_entraide_missions_atomic.sql', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(oldMissionSql).digest('hex'), '8b408c43e4a12609eac882797f2fc88d8a0c48366b7646aab71d39d9cefcdf72');
const upgrade = await readFile(new URL('20261110022000_entraide_mission_requests.sql', migrations), 'utf8');
const recorded = ['20261110020000_entraide_contact_atomic.sql', '20261110021000_entraide_missions_atomic.sql'];
let db; let beforeUpgrade; let publicId; let privateId;
const command = (actor, action, payload = {}) => callRpc(db, 'entraide_mission_command', actor, action, payload);
async function snapshot(database) {
  const result = {};
  for (const table of ['missions_collectives', 'missions_collectives_participants', 'entraide_contact_requests']) {
    result[table] = (await database.query(`SELECT to_jsonb(r) AS row FROM purama_ai.${table} r ORDER BY to_jsonb(r)::text`)).rows;
  }
  return result;
}
before(async () => {
  db = await createDb({ alreadyApplied: recorded, beforeCurrentMigrations: async previous => {
    await previous.exec(await readFile(new URL(recorded[0], migrations), 'utf8'));
    await previous.exec(oldMissionSql);
    await previous.exec('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY)');
    for (const file of recorded) await previous.query('INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1)', [file.slice(0, 14)]);
    await seedUsers(previous, [USERS.a, USERS.b, USERS.c]);
    publicId = randomUUID(); privateId = randomUUID();
    for (const [id, visibility] of [[publicId, 'public'], [privateId, 'private']]) {
      await callRpc(previous, 'entraide_mission_command', USERS.a, 'create', { id, title: 'Déjà appliquée', min_participants: 2, visibility });
    }
    await callRpc(previous, 'entraide_mission_command', USERS.b, 'join', { mission_id: publicId });
    const contactId = randomUUID();
    await callRpc(previous, 'entraide_contact_command', USERS.a, 'send', { id: contactId, recipient_id: USERS.c });
    await callRpc(previous, 'entraide_contact_command', USERS.c, 'respond', { request_id: contactId, response: 'accept' });
    beforeUpgrade = await snapshot(previous);
    assert.equal((await previous.query("SELECT to_regclass('purama_ai.entraide_mission_requests') AS registry")).rows[0].registry, null);
  } });
});
after(async () => { if (db) await db.close(); });

test('already-applied #23 upgrades additively without replaying 021000 or resetting records, counters, visibility and consent', async () => {
  assert.deepEqual(await snapshot(db), beforeUpgrade);
  assert.deepEqual((await db.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')).rows,
    recorded.map(file => ({ version: file.slice(0, 14) })));
  const publicMission = await command(USERS.c, 'get', { mission_id: publicId });
  assert.equal(publicMission.mission.revision, 1);
  assert.equal(publicMission.mission.visibility, 'public');
  assert.deepEqual(await command(USERS.c, 'get', { mission_id: privateId }), { error: 'mission_not_found', status: 404 });
  const functions = await db.query("SELECT to_regprocedure('purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)') AS legacy");
  assert.equal(functions.rows[0].legacy, null);
});

test('the additive upgrade installs durable request receipts with service-only access', async () => {
  const payload = { mission_id: publicId, expected_revision: 1, request_id: randomUUID() };
  const first = await command(USERS.a, 'cancel', payload);
  assert.equal(first.mission.status, 'annulee');
  assert.equal(first.mission.revision, 2);
  assert.equal(first.replayed, false);
  const repeat = await command(USERS.a, 'cancel', payload);
  assert.equal(repeat.replayed, true);
  assert.deepEqual(repeat.mission, first.mission);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asRole(db, role, USERS.a, 'SELECT * FROM purama_ai.entraide_mission_requests'), e => e.code === '42501');
  }
});

test('reapplying the known additive upgrade preserves complete receipts and mission state', async () => {
  const state = await snapshot(db);
  const receipts = (await db.query('SELECT * FROM purama_ai.entraide_mission_requests ORDER BY request_id')).rows;
  await db.transaction(tx => tx.exec(upgrade));
  assert.deepEqual(await snapshot(db), state);
  assert.deepEqual((await db.query('SELECT * FROM purama_ai.entraide_mission_requests ORDER BY request_id')).rows, receipts);
});

test('an unknown altered command body is refused before additive changes', async () => {
  const state = await snapshot(db);
  await assert.rejects(db.transaction(async tx => {
    await tx.exec(`CREATE OR REPLACE FUNCTION purama_ai.entraide_mission_command(p_actor uuid,p_action text,p_payload jsonb DEFAULT '{}')
      RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT '{}'::jsonb $$`);
    await tx.exec(upgrade);
  }), e => e.code === 'P0001' && e.message === 'entraide_missions_reconciliation_required');
  assert.deepEqual(await snapshot(db), state);
});

test('an unrecognized request registry is refused without adopting or rewriting it', async () => {
  const state = (await db.query('SELECT * FROM purama_ai.entraide_mission_requests')).rows;
  await assert.rejects(db.transaction(async tx => {
    await tx.exec("COMMENT ON TABLE purama_ai.entraide_mission_requests IS 'unknown-custom-registry'");
    await tx.exec(upgrade);
  }), e => e.code === 'P0001' && e.message === 'entraide_missions_reconciliation_required');
  assert.deepEqual((await db.query('SELECT * FROM purama_ai.entraide_mission_requests')).rows, state);
});
