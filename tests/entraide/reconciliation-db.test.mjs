import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { asRole, callRpc, createDb, seedUsers, USERS } from './db-harness.mjs';
import { createEntraideHandler } from '../../supabase/functions/_shared/entraide-http.ts';

// These exact #17 migrations are inert fixtures, never production migrations.
// The same tests run on PGlite or native PostgreSQL; only concurrency-db can
// establish overlapping native sessions and it explicitly skips without them.
const fixtures = new URL('./fixtures/', import.meta.url);
const migrations = new URL('../../supabase/migrations/', import.meta.url);
const original = await readFile(new URL('pr17-20261110000000_entraide_missions_atomic.sql', fixtures), 'utf8');
assert.equal(createHash('sha256').update(original).digest('hex'), 'f79766b153806bdd6aac382b66c1d8495133c766fc35a50675a32894670d7c36');
const signature = 'purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)';
const keys = { create: randomUUID(), join: randomUUID(), start: randomUUID() };
const originalInput = { title: 'Mission issue de #17', description: 'Travail collectif', min_participants: 2, max_participants: 4 };
let db; let originalMission; let oldReceipts; let guardObservation;

const command = (actor, action, payload = {}) => callRpc(db, 'entraide_mission_command', actor, action, payload);
const error = (result, code, status) => assert.deepEqual(result, { error: code, status });
const members = (mission) => mission.missions_collectives_participants.map(row => row.user_id).sort();
const read = async (id, actor = USERS.a) => (await command(actor, 'get', { mission_id: id })).mission;
const mutation = (id, revision, request_id = randomUUID()) => ({ mission_id: id, expected_revision: revision, request_id });
async function http(actor, path, body) {
  const handler = createEntraideHandler('entraide-missions', {
    authenticate: async () => ({ id: actor }),
    command: (_kind, user, action, payload) => command(user, action, payload),
  });
  const response = await handler(new Request(`https://entraide.invalid/entraide-missions${path}`, {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}
async function createMission(visibility = 'public') {
  const id = randomUUID();
  const result = await command(USERS.a, 'create', { ...originalInput, id, request_id: id, visibility });
  assert.ok(result.mission, JSON.stringify(result));
  return result.mission;
}

before(async () => {
  db = await createDb({ beforeCurrentMigrations: async legacy => {
    await seedUsers(legacy, Object.values(USERS));
    // Unknown source is refused by the new bridge without changing the function.
    await legacy.exec(`CREATE FUNCTION ${signature} RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT '{}'::jsonb $$`);
    const definition = async () => (await legacy.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS value', [signature])).rows[0].value;
    const beforeDefinition = await definition();
    await assert.rejects(legacy.transaction(async tx => {
      await tx.exec(await readFile(new URL('20261110021000_entraide_missions_atomic.sql', migrations), 'utf8'));
    }), e => e.code === 'P0001' && e.message === 'entraide_missions_reconciliation_required');
    guardObservation = { before: beforeDefinition, after: await definition() };
    await legacy.exec(`DROP FUNCTION ${signature}`);
    await legacy.exec(original);
    await legacy.exec(await readFile(new URL('pr17-20261110001000_entraide_own_profile.sql', fixtures), 'utf8'));
    const oldCommand = async (actor, request, action, missionId, payload, version) => {
      const result = await asRole(legacy, 'authenticated', actor,
        'SELECT purama_ai.entraide_mission_mutate($1::uuid,$2::text,$3::uuid,$4::jsonb,$5::bigint) AS result',
        [request, action, missionId, JSON.stringify(payload), version]);
      return result.rows[0].result;
    };
    const created = await oldCommand(USERS.a, keys.create, 'create', null, originalInput, null);
    const id = created.mission.id;
    await oldCommand(USERS.b, keys.join, 'join', id, {}, 1);
    originalMission = (await oldCommand(USERS.a, keys.start, 'start', id, {}, 2)).mission;
    oldReceipts = (await legacy.query('SELECT * FROM purama_ai.entraide_mission_requests ORDER BY request_id')).rows;
    // The original #23 guard still fails if someone skips the explicit bridge.
    await assert.rejects(legacy.transaction(async tx => {
      await tx.exec(await readFile(new URL('pr23-20261110021000_entraide_missions_atomic.sql', fixtures), 'utf8'));
    }), e => e.code === 'P0001' && e.message === 'entraide_missions_reconciliation_required');
  } });
});
after(async () => { if (db) await db.close(); });

test('unknown legacy authority still fails closed without replacement', () => {
  assert.equal(guardObservation.after, guardObservation.before);
});

test('actual #17 schema upgrades without changing identity, membership or lifecycle and is private by default', async () => {
  const current = await read(originalMission.id);
  assert.equal(current.id, originalMission.id);
  assert.equal(current.organizer_id, originalMission.organizer_id);
  assert.equal(current.status, 'en_cours');
  assert.equal(current.revision, originalMission.version - 1);
  assert.equal(current.visibility, 'private');
  assert.equal(current.created_at, originalMission.created_at);
  assert.equal(current.updated_at, originalMission.updated_at);
  assert.deepEqual(members(current), members(originalMission));
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='purama_ai' AND table_name='missions_collectives' AND column_name IN ('version','revision')")).rows;
  assert.deepEqual(columns, [{ column_name: 'revision' }]);
  error(await command(USERS.c, 'get', { mission_id: current.id }), 'mission_not_found', 404);
});

test('the legacy definer is removed and request receipts remain service-only', async () => {
  assert.equal((await db.query('SELECT to_regprocedure($1) AS value', [signature])).rows[0].value, null);
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['missions_collectives', 'missions_collectives_participants', 'entraide_mission_requests']) {
      await assert.rejects(asRole(db, role, USERS.a, `SELECT * FROM purama_ai.${table}`), e => e.code === '42501');
    }
    await assert.rejects(asRole(db, role, USERS.a,
      "SELECT purama_ai.entraide_mission_command($1::uuid,'list','{}')", [USERS.a]), e => e.code === '42501');
  }
});

test('legacy receipt identities, raw results and timestamps survive with an explicit counter translation', async () => {
  const receipts = (await db.query('SELECT * FROM purama_ai.entraide_mission_requests ORDER BY request_id')).rows;
  assert.equal(receipts.length, oldReceipts.length);
  for (let i = 0; i < receipts.length; i++) {
    const current = receipts[i]; const old = oldReceipts[i];
    for (const key of ['actor_id', 'request_id', 'action', 'mission_id', 'response', 'created_at']) assert.deepEqual(current[key], old[key], key);
    assert.equal(current.expected_revision === null ? null : Number(current.expected_revision), old.expected_version === null ? null : Number(old.expected_version) - 1);
    assert.equal('expected_version' in current, false);
  }
});

test('a migrated creation receipt maps its original request to the original mission, without creating another one', async () => {
  const result = await command(USERS.a, 'create', { ...originalInput, id: keys.create, request_id: keys.create, visibility: 'private' });
  assert.equal(result.replayed, true);
  assert.equal(result.mission.id, originalMission.id);
  assert.equal(result.mission.visibility, 'private');
  assert.equal(result.mission.revision, 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.missions_collectives WHERE id=$1', [keys.create])).rows[0].n, 0);
});

test('a migrated start receipt replays after a newer completion without repeating or reverting the effect', async () => {
  const done = await command(USERS.a, 'complete', mutation(originalMission.id, 2));
  assert.equal(done.mission.status, 'terminee');
  const replay = await command(USERS.a, 'start', mutation(originalMission.id, 1, keys.start));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.mission, done.mission);
});

test('the retained own-profile RPC still scopes coordinates to auth.uid()', async () => {
  await db.query('INSERT INTO purama_ai.entraide_profils(user_id,location_lat,location_lng) VALUES($1,10,20),($2,30,40)', [USERS.a, USERS.b]);
  const own = await asRole(db, 'authenticated', USERS.a, 'SELECT purama_ai.entraide_own_profile() AS result');
  assert.equal(own.rows[0].result.user_id, USERS.a);
  assert.equal(own.rows[0].result.location_lat, 10);
  await assert.rejects(asRole(db, 'anon', USERS.a, 'SELECT purama_ai.entraide_own_profile()'), e => e.code === '42501');
});

test('durable joins and leaves cannot be resurrected by out-of-order retries', async () => {
  const mission = await createMission();
  const join = mutation(mission.id, 0); const leave = mutation(mission.id, 1);
  assert.equal((await command(USERS.b, 'join', join)).replayed, false);
  const left = await command(USERS.b, 'leave', leave);
  const oldJoin = await command(USERS.b, 'join', join);
  assert.equal(oldJoin.replayed, true);
  assert.deepEqual(oldJoin.mission, left.mission);
  assert.deepEqual(members(oldJoin.mission), [USERS.a]);
  const rejoined = await command(USERS.b, 'join', mutation(mission.id, 2));
  const oldLeave = await command(USERS.b, 'leave', leave);
  assert.equal(oldLeave.replayed, true);
  assert.deepEqual(oldLeave.mission, rejoined.mission);
});

test('durable visibility receipts never re-publish after an explicit unpublish', async () => {
  const mission = await createMission('private');
  const publish = mutation(mission.id, 0);
  await command(USERS.a, 'publish', publish);
  const hidden = await command(USERS.a, 'unpublish', mutation(mission.id, 1));
  const replay = await command(USERS.a, 'publish', publish);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.mission, hidden.mission);
  error(await command(USERS.b, 'get', { mission_id: mission.id }), 'mission_not_found', 404);
});

test('a stored receipt never restores access after leaving a private mission', async () => {
  const mission = await createMission();
  const join = mutation(mission.id, 0); const leave = mutation(mission.id, 2);
  await command(USERS.b, 'join', join);
  await command(USERS.a, 'unpublish', mutation(mission.id, 1));
  await command(USERS.b, 'leave', leave);
  for (const [action, payload] of [['join', join], ['leave', leave]]) {
    error(await command(USERS.b, action, payload), 'mission_not_found', 404);
  }
  assert.deepEqual(members(await read(mission.id)), [USERS.a]);
});

test('a request identity is actor-scoped and cannot change action, mission, payload or precondition', async () => {
  const mission = await createMission();
  const intent = mutation(mission.id, 0);
  const joined = await command(USERS.b, 'join', intent);
  for (const [action, payload] of [
    ['leave', intent], ['join', { ...intent, mission_id: randomUUID() }],
    ['join', { ...intent, expected_revision: 1 }],
  ]) error(await command(USERS.b, action, payload), 'request_id_conflict', 409);
  assert.deepEqual(await read(mission.id), joined.mission);
  // Another verified actor owns a different command identity, even with that UUID.
  const other = await command(USERS.c, 'join', { ...intent, expected_revision: 1 });
  assert.equal(other.replayed, false);
  assert.ok(members(other.mission).includes(USERS.c));
});

test('business failures roll back request reservations and leave a reusable unconsumed identity', async () => {
  const mission = await createMission();
  const request_id = randomUUID();
  error(await command(USERS.b, 'join', mutation(mission.id, 99, request_id)), 'revision_conflict', 409);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_mission_requests WHERE request_id=$1', [request_id])).rows[0].n, 0);
  const success = await command(USERS.b, 'join', mutation(mission.id, 0, request_id));
  assert.equal(success.replayed, false);
  const invalid = randomUUID();
  error(await command(USERS.a, 'create', { id: randomUUID(), request_id: invalid, title: '', min_participants: 2 }), 'invalid_title', 400);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_mission_requests WHERE request_id=$1', [invalid])).rows[0].n, 0);
});

test('malformed request identities are refused without reserving or changing a mission', async () => {
  const mission = await createMission();
  for (const request_id of [null, 1, '', 'not-a-uuid', {}]) {
    error(await command(USERS.b, 'join', { mission_id: mission.id, request_id }), 'invalid_request_id', 400);
  }
  assert.deepEqual(await read(mission.id), mission);
});

test('HTTP accepts an in-flight #17 creation retry and returns its real mission through the canonical private DTO', async () => {
  const result = await http(USERS.a, '', { ...originalInput, request_id: keys.create });
  assert.equal(result.status, 200);
  assert.equal(result.body.replayed, true);
  assert.equal(result.body.mission.id, originalMission.id);
  assert.equal(result.body.mission.revision, 3);
  assert.equal(result.body.mission.visibility, 'private');
  assert.equal('version' in result.body.mission, false);
  assert.equal('initial_visibility' in result.body.mission, false);
});

test('HTTP translates the legacy write precondition once and rejects mixed counters or actor injection', async () => {
  const mission = await createMission('private');
  const request_id = randomUUID();
  const result = await http(USERS.a, `/${mission.id}/publish`, { request_id, expected_version: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.mission.revision, 1);
  assert.equal(result.body.replayed, false);
  const replay = await http(USERS.a, `/${mission.id}/publish`, { request_id, expected_revision: 0 });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.mission, result.body.mission);
  for (const body of [
    { request_id: randomUUID(), expected_revision: 1, expected_version: 2 },
    { request_id: randomUUID(), expected_version: 0 },
    { request_id: randomUUID(), expected_revision: 1, p_actor: USERS.b },
    { request_id: 42, expected_revision: 1 },
  ]) assert.deepEqual(await http(USERS.a, `/${mission.id}/unpublish`, body), { status: 400, body: { error: 'invalid_payload' } });
  assert.deepEqual(await read(mission.id), result.body.mission);
});
