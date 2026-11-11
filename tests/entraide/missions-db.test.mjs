import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { asRole, callRpc, createDb, seedUsers, USERS } from './db-harness.mjs';

// These tests execute the real migration/function and PostgreSQL roles in
// PGlite. They do not establish multi-connection concurrency, Supabase Auth,
// deployment, independently verified delivery, or any financial capability.
const commandName = 'entraide_mission_command';
const missionId = (number = 1) => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const memberIds = (mission) => mission.missions_collectives_participants.map((row) => row.user_id).sort();
const errorResult = (result, error, status) => assert.deepEqual(result, { error, status });
const denied = (promise) => assert.rejects(promise, (error) => error.code === '42501');
let db;
let legacyObservation;
let coexistenceObservation;

async function observeConflictingRpcGuard(legacy) {
  const signature = 'purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)';
  assert.equal((await legacy.query('SELECT to_regprocedure($1) AS existing', [signature])).rows[0].existing, null);
  // This function belongs only to the test. It is committed before the attempted
  // migration, so rollback must preserve it and its authenticated EXECUTE grant.
  await legacy.exec(`
    CREATE FUNCTION purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)
    RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = ''
    AS $$ SELECT '{"test_stub":true}'::jsonb $$;
    GRANT EXECUTE ON FUNCTION purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint) TO authenticated;
  `);
  const snapshot = () => legacy.query(`
    SELECT pg_get_functiondef(p.oid) AS definition, p.prosecdef AS security_definer,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
      has_table_privilege('authenticated', 'purama_ai.missions_collectives', 'SELECT') AS legacy_table_read,
      (SELECT title FROM purama_ai.missions_collectives WHERE id = $2::uuid) AS legacy_title,
      (SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'purama_ai.missions_collectives'::regclass
        AND attname IN ('revision', 'visibility', 'initial_visibility') AND NOT attisdropped) AS new_columns
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)
  `, [signature, missionId()]);
  try {
    const before = (await snapshot()).rows;
    const sql = await readFile(new URL('../../supabase/migrations/20261110021000_entraide_missions_atomic.sql', import.meta.url), 'utf8');
    let refusal;
    await assert.rejects(legacy.transaction(async (tx) => {
      // A real write witnesses rollback, not merely the guard's exception text.
      await tx.query("UPDATE purama_ai.missions_collectives SET title = 'Écriture à annuler' WHERE id = $1", [missionId()]);
      await tx.exec(sql);
    }), (error) => {
      refusal = { code: error.code, message: error.message };
      return error.code === 'P0001' && error.message === 'entraide_missions_reconciliation_required';
    });
    return { before, after: (await snapshot()).rows, refusal };
  } finally {
    // Remove only the stub this test created. No competing checkout is touched.
    await legacy.exec(`DROP FUNCTION ${signature}`);
  }
}

before(async () => {
  db = await createDb({
    beforeCurrentMigrations: async (legacy) => {
      await seedUsers(legacy, [USERS.a, USERS.b]);
      await legacy.query(`INSERT INTO purama_ai.missions_collectives
        (id,organizer_id,title,min_participants,status) VALUES ($1,$2,'Projet ancien',2,'prete')`, [missionId(), USERS.a]);
      await legacy.query(`INSERT INTO purama_ai.missions_collectives_participants (mission_id,user_id)
        VALUES ($1,$2),($1,$3)`, [missionId(), USERS.a, USERS.b]);
      coexistenceObservation = await observeConflictingRpcGuard(legacy);
    },
  });
  await seedUsers(db, Object.values(USERS));
  // Capture the actual migration outcome before per-test cleanup. Reusing this
  // database avoids keeping two large WASM database instances alive together.
  legacyObservation = {
    owner: await callRpc(db, commandName, USERS.a, 'get', { mission_id: missionId() }),
    outsider: await callRpc(db, commandName, USERS.c, 'get', { mission_id: missionId() }),
  };
});
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  await db.exec('TRUNCATE purama_ai.missions_collectives_participants, purama_ai.missions_collectives');
});

const command = (actor, action, payload = {}) => callRpc(db, commandName, actor, action, payload);
async function createMission(overrides = {}, actor = USERS.a) {
  const result = await command(actor, 'create', {
    id: missionId(), title: 'Création collective', description: 'Projet synthétique',
    min_participants: 2, ...overrides,
  });
  assert.ok(result.mission, JSON.stringify(result));
  return result.mission;
}
async function readMission(actor = USERS.a, id = missionId()) {
  const result = await command(actor, 'get', { mission_id: id });
  assert.ok(result.mission, JSON.stringify(result));
  return result.mission;
}

test('migration keeps SECURITY INVOKER, empty search_path and service-only execution', async () => {
  const result = await db.query(`
    SELECT p.prosecdef, p.proconfig,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS client_execute,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anonymous_execute,
           EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'purama_ai' AND p.proname = 'entraide_mission_command'
  `);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    prosecdef: false, proconfig: ['search_path=""'], service_execute: true,
    client_execute: false, anonymous_execute: false, public_execute: false,
  });
});

test('migration refuses the competing SECURITY DEFINER RPC and rolls back without altering it', () => {
  const { before, after, refusal } = coexistenceObservation;
  assert.deepEqual(refusal, { code: 'P0001', message: 'entraide_missions_reconciliation_required' });
  assert.equal(before.length, 1);
  assert.equal(before[0].security_definer, true);
  assert.equal(before[0].authenticated_execute, true);
  assert.equal(before[0].legacy_table_read, true);
  assert.equal(before[0].legacy_title, 'Projet ancien');
  assert.equal(before[0].new_columns, 0);
  assert.deepEqual(after, before);
});

test('real anon/authenticated roles cannot invoke the RPC or read private tables directly', async () => {
  await createMission();
  for (const role of ['anon', 'authenticated']) {
    await denied(asRole(db, role, USERS.a,
      'SELECT purama_ai.entraide_mission_command($1::uuid, $2::text, $3::jsonb)',
      [USERS.a, 'list', '{}']));
    await denied(asRole(db, role, USERS.a, 'SELECT * FROM purama_ai.missions_collectives'));
    await denied(asRole(db, role, USERS.a, 'SELECT * FROM purama_ai.missions_collectives_participants'));
    await denied(asRole(db, role, USERS.a,
      "UPDATE purama_ai.missions_collectives SET status = 'terminee'"));
  }
  errorResult(await command(null, 'list'), 'authentication_required', 403);
});

test('creation defaults to private and atomically includes only its organizer at revision zero', async () => {
  const mission = await createMission();
  assert.equal(mission.visibility, 'private');
  assert.equal(mission.status, 'ouverte');
  assert.equal(mission.revision, 0);
  assert.equal(mission.min_participants, 2);
  assert.equal(mission.max_participants, null);
  assert.equal(mission.organizer_id, USERS.a);
  assert.deepEqual(memberIds(mission), [USERS.a]);
});

test('stable create ID replays current state but conflicts on another author or content', async () => {
  const initial = await createMission({ visibility: 'public' });
  await command(USERS.b, 'join', { mission_id: initial.id });
  const replay = await createMission({ visibility: 'public' });
  assert.equal(replay.revision, 1);
  assert.equal(replay.created_at, initial.created_at);
  assert.deepEqual(memberIds(replay), [USERS.a, USERS.b]);
  const content = {
    id: initial.id, title: initial.title, description: initial.description,
    min_participants: 2, visibility: 'public',
  };
  errorResult(await command(USERS.b, 'create', content), 'create_conflict', 409);
  for (const change of [
    { title: 'Autre résultat' }, { description: 'Autre périmètre' },
    { min_participants: 3 }, { max_participants: 3 }, { visibility: 'private' },
  ]) {
    errorResult(await command(USERS.a, 'create', { ...content, ...change }), 'create_conflict', 409);
  }
  assert.deepEqual(await readMission(), replay);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM purama_ai.missions_collectives')).rows[0].count, 1);
});

test('create replay checks original visibility while returning the current published or hidden state', async () => {
  // Both directions matter: current visibility must never replace creation input.
  for (const [index, originalVisibility] of ['private', 'public'].entries()) {
    const id = missionId(index + 1);
    const original = {
      id, title: 'Création collective', description: 'Projet synthétique',
      min_participants: 2, visibility: originalVisibility,
    };
    const created = await createMission(original);
    const action = originalVisibility === 'private' ? 'publish' : 'unpublish';
    const otherVisibility = originalVisibility === 'private' ? 'public' : 'private';
    const changed = await command(USERS.a, action, { mission_id: id, expected_revision: 0 });
    assert.equal(changed.mission.visibility, otherVisibility);
    const replay = await command(USERS.a, 'create', original);
    assert.deepEqual(replay, changed);
    assert.equal(replay.mission.created_at, created.created_at);
    errorResult(await command(USERS.a, 'create', { ...original, visibility: otherVisibility }), 'create_conflict', 409);
    errorResult(await command(USERS.a, 'create', { ...original, title: 'Autre résultat' }), 'create_conflict', 409);
    const restored = await command(USERS.a, action === 'publish' ? 'unpublish' : 'publish', {
      mission_id: id, expected_revision: 1,
    });
    assert.deepEqual(await command(USERS.a, 'create', original), restored);
    errorResult(await command(USERS.a, 'create', { ...original, visibility: otherVisibility }), 'create_conflict', 409);
    assert.equal(restored.mission.revision, 2);
    assert.equal('initial_visibility' in restored.mission, false);
    assert.deepEqual((await db.query('SELECT initial_visibility FROM purama_ai.missions_collectives WHERE id = $1', [id])).rows,
      [{ initial_visibility: originalVisibility }]);
  }
  assert.equal((await db.query('SELECT count(*)::int AS count FROM purama_ai.missions_collectives')).rows[0].count, 2);
});

test('invalid creation and injected authority fields produce no mission or participant', async () => {
  const valid = { id: missionId(), title: 'Projet', min_participants: 2 };
  for (const change of [
    { id: 'invalid' }, { title: '  ' }, { title: 42 }, { title: 'x'.repeat(201) },
    { description: {} }, { description: 'x'.repeat(10001) },
    { min_participants: 1 }, { min_participants: 2.5 }, { min_participants: true },
    { min_participants: 2147483648 }, { max_participants: 1 }, { max_participants: '3' },
    { visibility: null }, { visibility: 'everyone' },
    { organizer_id: USERS.b }, { status: 'terminee' }, { participantIds: [USERS.b] },
  ]) {
    const result = await command(USERS.a, 'create', { ...valid, ...change });
    assert.equal(result.status, 400, JSON.stringify({ change, result }));
    assert.equal(typeof result.error, 'string');
  }
  for (const payload of [null, [], 'invalid']) {
    errorResult(await command(USERS.a, 'create', payload), 'invalid_payload', 400);
  }
  errorResult(await command(USERS.a, 'unknown'), 'invalid_action', 400);
  const counts = await db.query(`SELECT
    (SELECT count(*)::int FROM purama_ai.missions_collectives) AS missions,
    (SELECT count(*)::int FROM purama_ai.missions_collectives_participants) AS participants`);
  assert.deepEqual(counts.rows[0], { missions: 0, participants: 0 });
});

test('a failure in the organizer insertion rolls back the already inserted parent mission', async () => {
  await db.exec(`
    CREATE FUNCTION purama_ai.test_reject_mission_member() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected FK failure' USING ERRCODE = '23503'; END;
    $$;
    CREATE TRIGGER test_reject_mission_member BEFORE INSERT
      ON purama_ai.missions_collectives_participants FOR EACH ROW
      EXECUTE FUNCTION purama_ai.test_reject_mission_member();
  `);
  try {
    errorResult(await command(USERS.a, 'create', {
      id: missionId(), title: 'Création interrompue', min_participants: 2,
    }), 'actor_not_found', 403);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM purama_ai.missions_collectives')).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM purama_ai.missions_collectives_participants')).rows[0].count, 0);
  } finally {
    await db.exec(`DROP TRIGGER test_reject_mission_member ON purama_ai.missions_collectives_participants;
      DROP FUNCTION purama_ai.test_reject_mission_member()`);
  }
});

test('list/get expose public missions and private missions only to owners or existing participants', async () => {
  const privateA = await createMission({ id: missionId(1) });
  const publicA = await createMission({ id: missionId(2), visibility: 'public' });
  const privateB = await createMission({ id: missionId(3) }, USERS.b);
  await db.query('INSERT INTO purama_ai.missions_collectives_participants (mission_id,user_id) VALUES ($1,$2)', [privateB.id, USERS.a]);
  const ownerView = await command(USERS.a, 'list');
  assert.deepEqual(ownerView.missions.map((m) => m.id).sort(), [privateA.id, publicA.id, privateB.id].sort());
  const strangerView = await command(USERS.c, 'list');
  assert.deepEqual(strangerView.missions.map((m) => m.id), [publicA.id]);
  assert.equal((await readMission(USERS.a, privateB.id)).id, privateB.id);
  errorResult(await command(USERS.c, 'get', { mission_id: privateA.id }), 'mission_not_found', 404);
  errorResult(await command(USERS.c, 'get', { mission_id: missionId(99) }), 'mission_not_found', 404);
  errorResult(await command(USERS.c, 'join', { mission_id: privateA.id }), 'mission_not_found', 404);
  errorResult(await command(USERS.a, 'join', { mission_id: privateA.id }), 'private_join_not_available', 403);
});

test('a legacy private participant can leave, then loses read and replay access without another effect', async () => {
  await createMission();
  await db.query('INSERT INTO purama_ai.missions_collectives_participants (mission_id,user_id) VALUES ($1,$2)', [missionId(), USERS.b]);
  assert.deepEqual(memberIds(await readMission(USERS.b)), [USERS.a, USERS.b]);
  const left = await command(USERS.b, 'leave', { mission_id: missionId() });
  assert.deepEqual(memberIds(left.mission), [USERS.a]);
  assert.equal(left.mission.revision, 1);
  errorResult(await command(USERS.b, 'get', { mission_id: missionId() }), 'mission_not_found', 404);
  errorResult(await command(USERS.b, 'leave', { mission_id: missionId() }), 'mission_not_found', 404);
  assert.equal((await readMission()).revision, 1);
});

test('joins enforce the collective quorum and capacity; retries consume no further place or revision', async () => {
  await createMission({ min_participants: 3, max_participants: 3, visibility: 'public' });
  const joinedB = await command(USERS.b, 'join', { mission_id: missionId(), expected_revision: 0 });
  assert.equal(joinedB.mission.status, 'ouverte');
  assert.equal(joinedB.mission.revision, 1);
  const joinedC = await command(USERS.c, 'join', { mission_id: missionId() });
  assert.equal(joinedC.mission.status, 'prete');
  assert.equal(joinedC.mission.revision, 2);
  errorResult(await command(USERS.d, 'join', { mission_id: missionId() }), 'mission_full', 409);
  assert.deepEqual((await command(USERS.b, 'join', { mission_id: missionId(), expected_revision: 0 })).mission, joinedC.mission);
  assert.deepEqual(memberIds(await readMission()), [USERS.a, USERS.b, USERS.c]);
});

test('leave changes only that participant and reopens a recruiting mission when quorum is lost', async () => {
  const created = await createMission({ visibility: 'public' });
  await command(USERS.b, 'join', { mission_id: missionId() });
  const left = await command(USERS.b, 'leave', { mission_id: missionId() });
  assert.equal(left.mission.status, 'ouverte');
  assert.equal(left.mission.revision, 2);
  assert.deepEqual(left.mission.missions_collectives_participants, created.missions_collectives_participants);
  assert.deepEqual((await command(USERS.b, 'leave', { mission_id: missionId(), expected_revision: 1 })).mission, left.mission);
});

test('departure during execution preserves en_cours; it never recruits again automatically', async () => {
  await createMission({ visibility: 'public' });
  await command(USERS.b, 'join', { mission_id: missionId() });
  await command(USERS.a, 'start', { mission_id: missionId(), expected_revision: 1 });
  const left = await command(USERS.b, 'leave', { mission_id: missionId() });
  assert.equal(left.mission.status, 'en_cours');
  assert.equal(left.mission.revision, 3);
  assert.deepEqual(memberIds(left.mission), [USERS.a]);
  errorResult(await command(USERS.c, 'join', { mission_id: missionId() }), 'mission_not_recruiting', 409);
  const completed = await command(USERS.a, 'complete', { mission_id: missionId(), expected_revision: 3 });
  assert.equal(completed.mission.status, 'terminee');
});

test('organizer cannot silently abandon ouverte, prete or en_cours missions', async () => {
  await createMission({ visibility: 'public' });
  for (const revision of [0, 1, 2]) {
    errorResult(await command(USERS.a, 'leave', { mission_id: missionId() }), 'organizer_must_cancel', 409);
    assert.equal((await readMission()).revision, revision);
    if (revision === 0) await command(USERS.b, 'join', { mission_id: missionId() });
    if (revision === 1) await command(USERS.a, 'start', { mission_id: missionId(), expected_revision: 1 });
  }
  const cancelled = await command(USERS.a, 'cancel', { mission_id: missionId(), expected_revision: 2 });
  assert.equal(cancelled.mission.status, 'annulee');
  assert.deepEqual(memberIds(cancelled.mission), [USERS.a, USERS.b]);
});

test('participants and other members cannot change lifecycle or visibility for the organizer', async () => {
  await createMission({ visibility: 'public' });
  await command(USERS.b, 'join', { mission_id: missionId() });
  for (const actor of [USERS.b, USERS.c]) {
    for (const action of ['start', 'complete', 'cancel', 'publish', 'unpublish']) {
      errorResult(await command(actor, action, { mission_id: missionId(), expected_revision: 1 }), 'organizer_only', 403);
    }
  }
  assert.equal((await readMission()).status, 'prete');
  assert.equal((await readMission()).revision, 1);
});

test('organizer transitions require the current revision and preserve terminal states', async () => {
  await createMission({ visibility: 'public' });
  for (const action of ['start', 'complete', 'cancel', 'publish', 'unpublish']) {
    errorResult(await command(USERS.a, action, { mission_id: missionId() }), 'expected_revision_required', 400);
  }
  errorResult(await command(USERS.a, 'start', { mission_id: missionId(), expected_revision: 0 }), 'not_ready', 409);
  errorResult(await command(USERS.a, 'complete', { mission_id: missionId(), expected_revision: 0 }), 'not_in_progress', 409);
  await command(USERS.b, 'join', { mission_id: missionId() });
  errorResult(await command(USERS.a, 'start', { mission_id: missionId(), expected_revision: 0 }), 'revision_conflict', 409);
  const started = await command(USERS.a, 'start', { mission_id: missionId(), expected_revision: 1 });
  assert.equal(started.mission.status, 'en_cours');
  assert.equal(started.mission.revision, 2);
  errorResult(await command(USERS.a, 'complete', { mission_id: missionId(), expected_revision: 1 }), 'revision_conflict', 409);
  const completed = await command(USERS.a, 'complete', { mission_id: missionId(), expected_revision: 2 });
  assert.equal(completed.mission.status, 'terminee');
  assert.equal(completed.mission.revision, 3);
  errorResult(await command(USERS.a, 'cancel', { mission_id: missionId(), expected_revision: 3 }), 'already_closed', 409);
  errorResult(await command(USERS.b, 'leave', { mission_id: missionId() }), 'mission_closed', 409);
  errorResult(await command(USERS.c, 'join', { mission_id: missionId() }), 'mission_not_recruiting', 409);
  assert.deepEqual(await readMission(), completed.mission);
});

test('an old optional revision blocks a new membership effect but not a harmless replay', async () => {
  await createMission({ visibility: 'public' });
  await command(USERS.b, 'join', { mission_id: missionId(), expected_revision: 0 });
  errorResult(await command(USERS.c, 'join', { mission_id: missionId(), expected_revision: 0 }), 'revision_conflict', 409);
  errorResult(await command(USERS.b, 'leave', { mission_id: missionId(), expected_revision: 0 }), 'revision_conflict', 409);
  const left = await command(USERS.b, 'leave', { mission_id: missionId(), expected_revision: 1 });
  assert.equal(left.mission.revision, 2);
  assert.deepEqual(memberIds(left.mission), [USERS.a]);
  assert.deepEqual((await command(USERS.b, 'leave', { mission_id: missionId(), expected_revision: 1 })).mission, left.mission);
});

test('cancellation is allowed in each non-terminal state without deleting participants', async () => {
  for (let stage = 0; stage < 3; stage += 1) {
    const id = missionId(stage + 1);
    await createMission({ id, visibility: 'public' });
    if (stage >= 1) await command(USERS.b, 'join', { mission_id: id });
    if (stage >= 2) await command(USERS.a, 'start', { mission_id: id, expected_revision: 1 });
    const previous = await readMission(USERS.a, id);
    const cancelled = await command(USERS.a, 'cancel', { mission_id: id, expected_revision: stage });
    assert.equal(cancelled.mission.status, 'annulee');
    assert.equal(cancelled.mission.revision, stage + 1);
    assert.deepEqual(cancelled.mission.missions_collectives_participants, previous.missions_collectives_participants);
    errorResult(await command(USERS.a, 'cancel', { mission_id: id, expected_revision: stage + 1 }), 'already_closed', 409);
  }
});

test('malformed revisions and injected membership/status fields cannot mutate a mission', async () => {
  const initial = await createMission({ visibility: 'public' });
  for (const expected_revision of [null, -1, 0.5, '0', true, 1e30]) {
    errorResult(await command(USERS.b, 'join', { mission_id: missionId(), expected_revision }), 'invalid_revision', 400);
  }
  for (const change of [{ organizer_id: USERS.b }, { status: 'terminee' }, { participants: [USERS.b] }]) {
    errorResult(await command(USERS.b, 'join', { mission_id: missionId(), ...change }), 'unsupported_field', 400);
  }
  assert.deepEqual(await readMission(), initial);
});

test('database constraints reject invalid privacy and revisions even outside the RPC', async () => {
  await createMission();
  await assert.rejects(db.query("UPDATE purama_ai.missions_collectives SET visibility = 'unknown'"), (error) => error.code === '23514');
  await assert.rejects(db.query("UPDATE purama_ai.missions_collectives SET initial_visibility = 'unknown'"), (error) => error.code === '23514');
  await assert.rejects(db.query('UPDATE purama_ai.missions_collectives SET revision = -1'), (error) => error.code === '23514');
  await assert.rejects(db.query('UPDATE purama_ai.missions_collectives SET visibility = NULL'), (error) => error.code === '23502');
  assert.equal((await readMission()).visibility, 'private');
  assert.equal((await readMission()).revision, 0);
});

test('an owner publishes to recruit, then unpublishes while preserving existing participants and their access', async () => {
  const created = await createMission();
  errorResult(await command(USERS.b, 'get', { mission_id: missionId() }), 'mission_not_found', 404);
  errorResult(await command(USERS.b, 'publish', { mission_id: missionId(), expected_revision: 0 }), 'mission_not_found', 404);
  const published = await command(USERS.a, 'publish', { mission_id: missionId(), expected_revision: 0 });
  assert.equal(published.mission.visibility, 'public');
  assert.equal(published.mission.revision, 1);
  assert.deepEqual(published.mission.missions_collectives_participants, created.missions_collectives_participants);
  assert.equal((await readMission(USERS.b)).visibility, 'public');
  const joined = await command(USERS.b, 'join', { mission_id: missionId(), expected_revision: 1 });
  assert.equal(joined.mission.status, 'prete');
  assert.equal(joined.mission.revision, 2);
  errorResult(await command(USERS.b, 'unpublish', { mission_id: missionId(), expected_revision: 2 }), 'organizer_only', 403);
  const hidden = await command(USERS.a, 'unpublish', { mission_id: missionId(), expected_revision: 2 });
  assert.equal(hidden.mission.visibility, 'private');
  assert.equal(hidden.mission.revision, 3);
  assert.deepEqual(hidden.mission.missions_collectives_participants, joined.mission.missions_collectives_participants);
  assert.equal((await readMission(USERS.b)).visibility, 'private');
  errorResult(await command(USERS.c, 'get', { mission_id: missionId() }), 'mission_not_found', 404);
  assert.deepEqual((await command(USERS.c, 'list')).missions, []);
  errorResult(await command(USERS.c, 'join', { mission_id: missionId() }), 'mission_not_found', 404);
});

test('visibility changes require a current revision; harmless replays do not consume another revision', async () => {
  await createMission();
  errorResult(await command(USERS.a, 'publish', { mission_id: missionId() }), 'expected_revision_required', 400);
  const published = await command(USERS.a, 'publish', { mission_id: missionId(), expected_revision: 0 });
  assert.deepEqual((await command(USERS.a, 'publish', { mission_id: missionId(), expected_revision: 0 })).mission, published.mission);
  errorResult(await command(USERS.a, 'unpublish', { mission_id: missionId(), expected_revision: 0 }), 'revision_conflict', 409);
  const hidden = await command(USERS.a, 'unpublish', { mission_id: missionId(), expected_revision: 1 });
  assert.deepEqual((await command(USERS.a, 'unpublish', { mission_id: missionId(), expected_revision: 1 })).mission, hidden.mission);
  assert.equal(hidden.mission.revision, 2);
});

test('visibility cannot change once work has started or the mission has closed', async () => {
  await createMission({ visibility: 'public' });
  await command(USERS.b, 'join', { mission_id: missionId() });
  await command(USERS.a, 'start', { mission_id: missionId(), expected_revision: 1 });
  for (const action of ['publish', 'unpublish']) {
    errorResult(await command(USERS.a, action, { mission_id: missionId(), expected_revision: 2 }), 'mission_not_recruiting', 409);
  }
  await command(USERS.a, 'complete', { mission_id: missionId(), expected_revision: 2 });
  errorResult(await command(USERS.a, 'unpublish', { mission_id: missionId(), expected_revision: 3 }), 'mission_not_recruiting', 409);
  assert.equal((await readMission()).visibility, 'public');
});

test('applying the migration makes pre-existing records private without rewriting their participants', () => {
  assert.equal(legacyObservation.owner.mission.visibility, 'private');
  assert.equal(legacyObservation.owner.mission.revision, 0);
  assert.equal(legacyObservation.owner.mission.status, 'prete');
  assert.deepEqual(memberIds(legacyObservation.owner.mission), [USERS.a, USERS.b]);
  errorResult(legacyObservation.outsider, 'mission_not_found', 404);
});
