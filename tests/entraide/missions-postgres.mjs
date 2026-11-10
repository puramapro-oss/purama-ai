import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ACTORS, RPC_SIGNATURE, createFixture, rpc, transactionResult, waitForLockWaiters } from './postgres-fixture.mjs';

let db;
before(async () => { db = await createFixture(); }, { timeout: 30_000 });
after(async () => { await db?.close(); }, { timeout: 30_000 });
beforeEach(async () => { await db.reset(); });

const payload = (extra = {}) => ({ title: 'Coup de main test', description: 'Données synthétiques', min_participants: 2, max_participants: null, ...extra });
const members = (response) => response.mission.missions_collectives_participants.map((row) => row.user_id).sort();
const invoke = (actor, command) => db.asActor(actor, (client) => rpc(client, command));
const create = (extra = {}, actor = ACTORS.owner, requestId = randomUUID()) => invoke(actor, { requestId, action: 'create', payload: payload(extra) });

async function rejectsCode(promise, reason, code = 'P0001') {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (reason !== null) assert.equal(error.message, reason);
    return true;
  });
}

async function snapshot(id) {
  const mission = (await db.admin.query('SELECT to_jsonb(m) AS row FROM purama_ai.missions_collectives m WHERE id=$1', [id])).rows[0]?.row;
  const participants = (await db.admin.query('SELECT user_id,joined_at::text FROM purama_ai.missions_collectives_participants WHERE mission_id=$1 ORDER BY user_id', [id])).rows;
  return { mission, participants };
}

async function concurrentOnMission(missionId, commands) {
  const lock = await db.connect();
  const clients = [];
  let pending = [];
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM purama_ai.missions_collectives WHERE id=$1 FOR UPDATE', [missionId]);
    for (const item of commands) clients.push(await db.beginActor(item.actor));
    pending = clients.map((client, index) => transactionResult(client, commands[index].command));
    const waiters = await waitForLockWaiters(db.admin, clients);
    await lock.query('COMMIT');
    return { results: await Promise.all(pending), waiters };
  } finally {
    await lock.query('ROLLBACK').catch(() => {});
    await Promise.allSettled(pending);
    await Promise.allSettled(clients.map((client) => db.release(client)));
    await db.release(lock);
  }
}

test('the real RPC is SECURITY DEFINER with a fixed empty search_path and no anonymous execution', async () => {
  const row = (await db.admin.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [RPC_SIGNATURE])).rows[0];
  assert.equal(row.prosecdef, true);
  assert.ok(row.proconfig.some((setting) => /^search_path=(""|)$/.test(setting)));
  assert.equal((await db.admin.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [RPC_SIGNATURE])).rows[0].allowed, false);
  assert.equal((await db.admin.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", [RPC_SIGNATURE])).rows[0].allowed, true);
  await rejectsCode(db.asRole('anon', null, (client) => rpc(client, { action: 'create', payload: payload() })), null, '42501');
  await rejectsCode(invoke(null, { action: 'create', payload: payload() }), 'auth_required');
});

test('authenticated callers cannot read the idempotence ledger or directly mutate missions', async () => {
  const first = await create();
  for (const query of [
    'SELECT * FROM purama_ai.entraide_mission_requests',
    "UPDATE purama_ai.missions_collectives SET status='terminee'",
    'DELETE FROM purama_ai.missions_collectives_participants',
  ]) await rejectsCode(db.asRole('authenticated', ACTORS.owner, (client) => client.query(query)), null, '42501');
  const after = await snapshot(first.mission.id);
  assert.equal(after.mission.version, 1);
  assert.equal(after.participants.length, 1);
});

test('existing RLS isolates contacts and blockers and hides exact profile coordinates', async () => {
  const visible = randomUUID();
  const hidden = randomUUID();
  await db.admin.query('INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id) VALUES ($1,$2,$3),($4,$5,$6)', [visible, ACTORS.owner, ACTORS.b, hidden, ACTORS.c, ACTORS.d]);
  await db.admin.query('INSERT INTO purama_ai.entraide_profils(user_id,location_lat,location_lng) VALUES ($1,47,6)', [ACTORS.owner]);
  await db.asRole('authenticated', ACTORS.owner, async (client) => {
    assert.deepEqual((await client.query('SELECT id FROM purama_ai.entraide_contact_requests')).rows.map((row) => row.id), [visible]);
    await client.query('INSERT INTO purama_ai.entraide_blocages(blocker_id,blocked_id) VALUES ($1,$2)', [ACTORS.owner, ACTORS.b]);
    await rejectsCode(client.query('INSERT INTO purama_ai.entraide_blocages(blocker_id,blocked_id) VALUES ($1,$2)', [ACTORS.c, ACTORS.d]), null, '42501');
    await rejectsCode(client.query('SELECT location_lat FROM purama_ai.entraide_profils'), null, '42501');
    assert.equal((await client.query('SELECT user_id FROM purama_ai.entraide_profils')).rowCount, 1);
  });
  await db.asRole('authenticated', ACTORS.c, async (client) => {
    assert.equal((await client.query('SELECT * FROM purama_ai.entraide_blocages')).rowCount, 0);
  });
});

test('creation returns the database identity, initial owner membership and version one', async () => {
  const result = await create({ title: '  Préparer les colis  ' });
  assert.equal(result.replayed, false);
  assert.equal(result.mission.title, 'Préparer les colis');
  assert.equal(result.mission.organizer_id, ACTORS.owner);
  assert.equal(result.mission.status, 'ouverte');
  assert.equal(result.mission.version, 1);
  assert.deepEqual(members(result), [ACTORS.owner]);
});

test('own-profile RPC returns only the caller profile including their precise coordinates', async () => {
  await db.admin.query(`
    INSERT INTO purama_ai.entraide_profils(user_id,location_lat,location_lng)
    VALUES ($1,47,6),($2,48,7)
  `, [ACTORS.owner, ACTORS.b]);
  const ownProfile = (actor) => db.asActor(actor, async (client) =>
    (await client.query('SELECT purama_ai.entraide_own_profile() AS profile')).rows[0].profile);
  const owner = await ownProfile(ACTORS.owner);
  assert.equal(owner.user_id, ACTORS.owner);
  assert.equal(owner.location_lat, 47);
  assert.equal(owner.location_lng, 6);
  const other = await ownProfile(ACTORS.b);
  assert.equal(other.user_id, ACTORS.b);
  assert.equal(other.location_lat, 48);
  assert.equal(other.location_lng, 7);
  assert.equal(await ownProfile(ACTORS.outsider), null);
  assert.equal(await ownProfile(null), null);
});

test('own-profile RPC is parameterless, stable, fixed-path and unavailable to anon', async () => {
  const signature = 'purama_ai.entraide_own_profile()';
  const row = (await db.admin.query('SELECT pronargs,provolatile,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0];
  assert.equal(row.pronargs, 0);
  assert.equal(row.provolatile, 's');
  assert.equal(row.prosecdef, true);
  assert.ok(row.proconfig.some((setting) => /^search_path=(""|)$/.test(setting)));
  assert.equal((await db.admin.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, false);
  await rejectsCode(db.asRole('anon', null, (client) => client.query('SELECT purama_ai.entraide_own_profile()')), null, '42501');
});

test('own-profile migration changes neither public profile policies nor direct coordinate privileges', async () => {
  assert.deepEqual(await db.profileAccess(), db.profileAccessBefore);
  assert.ok(db.profileAccessBefore.coordinates.every((row) => row.allowed === false));
  await db.admin.query('INSERT INTO purama_ai.entraide_profils(user_id,location_lat,location_lng) VALUES ($1,47,6)', [ACTORS.owner]);
  await rejectsCode(db.asRole('authenticated', ACTORS.owner, (client) =>
    client.query('SELECT location_lat,location_lng FROM purama_ai.entraide_profils WHERE user_id=$1', [ACTORS.owner])), null, '42501');
});

test('invalid commands do not reserve a request key or write a mission', async () => {
  for (const command of [
    { requestId: null, action: 'create', payload: payload() },
    { action: 'unknown' },
    { action: 'create', payload: payload({ min_participants: 1 }) },
    { action: 'create', payload: payload({ max_participants: 1 }) },
    { action: 'create', payload: payload({ min_participants: 2.5 }) },
    { action: 'create', payload: payload({ min_participants: 'bad' }) },
    { action: 'create', payload: payload({ unexpected: true }) },
  ]) await rejectsCode(invoke(ACTORS.owner, command), 'invalid_request');
  assert.equal((await db.admin.query('SELECT * FROM purama_ai.entraide_mission_requests')).rowCount, 0);
  assert.equal((await db.admin.query('SELECT * FROM purama_ai.missions_collectives')).rowCount, 0);
});

test('quorum transitions are recalculated after join and leave before starting', async () => {
  const initial = await create();
  const id = initial.mission.id;
  const joined = await invoke(ACTORS.b, { action: 'join', missionId: id });
  assert.equal(joined.mission.status, 'prete');
  assert.equal(joined.mission.version, 2);
  const left = await invoke(ACTORS.b, { action: 'leave', missionId: id });
  assert.equal(left.mission.status, 'ouverte');
  assert.equal(left.mission.version, 3);
  await rejectsCode(invoke(ACTORS.owner, { action: 'start', missionId: id, expectedVersion: 3 }), 'not_ready');
});

test('owner authorization and expected versions are enforced without changing the mission', async () => {
  const initial = await create();
  const id = initial.mission.id;
  await invoke(ACTORS.b, { action: 'join', missionId: id });
  const before = await snapshot(id);
  for (const action of ['start', 'complete', 'cancel']) {
    await rejectsCode(invoke(ACTORS.outsider, { action, missionId: id, expectedVersion: 2 }), 'organizer_required');
    assert.deepEqual(await snapshot(id), before);
  }
  await rejectsCode(invoke(ACTORS.owner, { action: 'start', missionId: id }), 'invalid_request');
  await rejectsCode(invoke(ACTORS.owner, { action: 'start', missionId: id, expectedVersion: 1 }), 'stale_mission');
  const started = await invoke(ACTORS.owner, { action: 'start', missionId: id, expectedVersion: 2 });
  assert.equal(started.mission.status, 'en_cours');
  assert.equal(started.mission.version, 3);
});

test('leaving an active mission remains possible and retains stable owner identity', async () => {
  const initial = await create();
  const id = initial.mission.id;
  await invoke(ACTORS.b, { action: 'join', missionId: id });
  await invoke(ACTORS.owner, { action: 'start', missionId: id, expectedVersion: 2 });
  const ownerLeft = await invoke(ACTORS.owner, { action: 'leave', missionId: id });
  assert.equal(ownerLeft.mission.status, 'en_cours');
  assert.equal(ownerLeft.mission.organizer_id, ACTORS.owner);
  const allLeft = await invoke(ACTORS.b, { action: 'leave', missionId: id });
  assert.equal(allLeft.mission.status, 'en_cours');
  assert.deepEqual(members(allLeft), []);
  const ended = await invoke(ACTORS.owner, { action: 'complete', missionId: id, expectedVersion: 5 });
  assert.equal(ended.mission.status, 'terminee');
  assert.equal(ended.mission.version, 6);
});

for (const finalAction of ['complete', 'cancel']) {
  test(`terminal state after ${finalAction} rejects new transitions and preserves all data`, async () => {
    const initial = await create();
    const id = initial.mission.id;
    await invoke(ACTORS.b, { action: 'join', missionId: id });
    await invoke(ACTORS.owner, { action: 'start', missionId: id, expectedVersion: 2 });
    await invoke(ACTORS.owner, { action: finalAction, missionId: id, expectedVersion: 3 });
    const before = await snapshot(id);
    for (const [actor, action, reason] of [
      [ACTORS.c, 'join', 'mission_not_recruiting'],
      [ACTORS.b, 'leave', 'mission_closed'],
      [ACTORS.c, 'leave', 'not_a_participant'],
      [ACTORS.owner, 'start', 'not_ready'],
      [ACTORS.owner, 'complete', 'not_in_progress'],
      [ACTORS.owner, 'cancel', 'already_closed'],
    ]) {
      await rejectsCode(invoke(actor, { action, missionId: id, expectedVersion: ['start', 'complete', 'cancel'].includes(action) ? 4 : null }), reason);
      assert.deepEqual(await snapshot(id), before);
    }
  });
}

test('idempotence replays the stored snapshot after later mission changes', async () => {
  const requestId = randomUUID();
  const initial = await create({}, ACTORS.owner, requestId);
  await invoke(ACTORS.b, { action: 'join', missionId: initial.mission.id });
  const replay = await create({}, ACTORS.owner, requestId);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.mission, initial.mission);
  assert.equal((await snapshot(initial.mission.id)).mission.version, 2);
  await rejectsCode(create({ title: 'Une autre demande' }, ACTORS.owner, requestId), 'request_id_conflict');
  assert.equal((await db.admin.query('SELECT * FROM purama_ai.missions_collectives')).rowCount, 1);
});

test('request keys are scoped to the authenticated actor', async () => {
  const requestId = randomUUID();
  const a = await create({}, ACTORS.owner, requestId);
  const b = await create({}, ACTORS.b, requestId);
  assert.notEqual(a.mission.id, b.mission.id);
  assert.equal(a.mission.organizer_id, ACTORS.owner);
  assert.equal(b.mission.organizer_id, ACTORS.b);
  assert.equal((await db.admin.query('SELECT * FROM purama_ai.entraide_mission_requests')).rowCount, 2);
});

test('a replayed join or leave succeeds once while a new request receives the canonical refusal', async () => {
  const initial = await create();
  const id = initial.mission.id;
  const joinId = randomUUID();
  const leaveId = randomUUID();
  await invoke(ACTORS.b, { requestId: joinId, action: 'join', missionId: id });
  assert.equal((await invoke(ACTORS.b, { requestId: joinId, action: 'join', missionId: id })).replayed, true);
  await rejectsCode(invoke(ACTORS.b, { action: 'join', missionId: id }), 'already_joined');
  await invoke(ACTORS.b, { requestId: leaveId, action: 'leave', missionId: id });
  assert.equal((await invoke(ACTORS.b, { requestId: leaveId, action: 'leave', missionId: id })).replayed, true);
  await rejectsCode(invoke(ACTORS.b, { action: 'leave', missionId: id }), 'not_a_participant');
  assert.equal((await snapshot(id)).mission.version, 3);
});

test('a late trigger failure rolls back participants, version and request reservation together', async () => {
  const initial = await create();
  const id = initial.mission.id;
  const requestId = randomUUID();
  const before = await snapshot(id);
  await db.admin.query(`
    CREATE FUNCTION purama_ai.test_fail_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('purama_test.fail_mutation',true)='on' THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='injected_failure';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_fail_mutation BEFORE UPDATE ON purama_ai.missions_collectives
      FOR EACH ROW EXECUTE FUNCTION purama_ai.test_fail_mutation();
  `);
  try {
    await rejectsCode(db.asActor(ACTORS.b, async (client) => {
      await client.query("SELECT set_config('purama_test.fail_mutation','on',true)");
      return rpc(client, { requestId, action: 'join', missionId: id });
    }), 'injected_failure');
    assert.deepEqual(await snapshot(id), before);
    assert.equal((await db.admin.query('SELECT * FROM purama_ai.entraide_mission_requests WHERE actor_id=$1 AND request_id=$2', [ACTORS.b, requestId])).rowCount, 0);
    const retried = await invoke(ACTORS.b, { requestId, action: 'join', missionId: id });
    assert.equal(retried.replayed, false);
    assert.equal(retried.mission.version, 2);
  } finally {
    await db.admin.query('DROP TRIGGER test_fail_mutation ON purama_ai.missions_collectives; DROP FUNCTION purama_ai.test_fail_mutation()');
  }
});

test('two PostgreSQL connections competing for the last place yield one winner and no overbooking', async () => {
  const initial = await create({ max_participants: 2 });
  const id = initial.mission.id;
  const { results, waiters } = await concurrentOnMission(id, [
    { actor: ACTORS.b, command: { action: 'join', missionId: id } },
    { actor: ACTORS.c, command: { action: 'join', missionId: id } },
  ]);
  assert.equal(waiters.length, 2);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const rejected = results.find((result) => !result.ok);
  assert.equal(rejected.error.code, 'P0001');
  assert.equal(rejected.error.message, 'mission_full');
  const end = await snapshot(id);
  assert.equal(end.participants.length, 2);
  assert.equal(end.mission.version, 2);
  assert.ok(end.participants.some((row) => row.user_id === ACTORS.owner));
});

test('concurrent join and leave preserve every unrelated member and their original join time', async () => {
  const initial = await create({ max_participants: 6 });
  const id = initial.mission.id;
  for (const actor of [ACTORS.b, ACTORS.c, ACTORS.d]) await invoke(actor, { action: 'join', missionId: id });
  const original = await snapshot(id);
  const { results } = await concurrentOnMission(id, [
    { actor: ACTORS.b, command: { action: 'leave', missionId: id } },
    { actor: ACTORS.e, command: { action: 'join', missionId: id } },
  ]);
  assert.ok(results.every((result) => result.ok));
  const end = await snapshot(id);
  assert.deepEqual(end.participants.map((row) => row.user_id).sort(), [ACTORS.owner, ACTORS.c, ACTORS.d, ACTORS.e].sort());
  assert.deepEqual(end.participants.filter((row) => row.user_id !== ACTORS.e), original.participants.filter((row) => row.user_id !== ACTORS.b));
  assert.equal(end.mission.version, 6);
});

for (const conflicting of [false, true]) {
  test(`two transactions using one request key ${conflicting ? 'reject a conflicting payload' : 'create exactly one mission'}`, async () => {
    const first = await db.beginActor(ACTORS.owner);
    const second = await db.beginActor(ACTORS.owner);
    const requestId = randomUUID();
    let pending;
    try {
      assert.notEqual(first.processID, second.processID);
      const initial = await rpc(first, { requestId, action: 'create', payload: payload() });
      pending = transactionResult(second, { requestId, action: 'create', payload: payload(conflicting ? { title: 'Demande concurrente différente' } : {}) });
      await waitForLockWaiters(db.admin, [second]);
      await first.query('COMMIT');
      const result = await pending;
      if (conflicting) {
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'P0001');
        assert.equal(result.error.message, 'request_id_conflict');
      } else {
        assert.equal(result.ok, true);
        assert.equal(result.response.replayed, true);
        assert.deepEqual(result.response.mission, initial.mission);
      }
      assert.equal((await db.admin.query('SELECT * FROM purama_ai.missions_collectives')).rowCount, 1);
      assert.equal((await db.admin.query('SELECT * FROM purama_ai.entraide_mission_requests')).rowCount, 1);
    } finally {
      await first.query('ROLLBACK').catch(() => {});
      if (pending) await Promise.allSettled([pending]);
      await Promise.allSettled([db.release(first), db.release(second)]);
    }
  });
}
