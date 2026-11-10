import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { callRpc, createDb, seedUsers, USERS } from './db-harness.mjs';

const enabled = Boolean(process.env.ENTRAIDE_DATABASE_URL);
const nativeOnly = {
  skip: enabled ? false : 'Requires isolated native PostgreSQL via ENTRAIDE_DATABASE_URL; PGlite has no independent concurrent connections',
  timeout: 30_000,
};
const missionRpc = 'entraide_mission_command';
const contactRpc = 'entraide_contact_command';
const id = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db;

before(async () => {
  if (!enabled) return;
  db = await createDb();
  assert.equal(db.engine, 'postgres', 'Concurrency evidence requires the native adapter');
  await seedUsers(db, Object.values(USERS));
});

after(async () => {
  if (db) await db.close();
});

beforeEach(async () => {
  if (!db) return;
  await db.exec(`TRUNCATE purama_ai.missions_collectives_participants,
    purama_ai.missions_collectives, purama_ai.entraide_contact_requests,
    purama_ai.entraide_blocages, purama_ai.entraide_mission_requests`);
});

async function waitForDistinctBlockedClients(rpcName, expected) {
  const deadline = Date.now() + 5_000;
  let observed = [];
  while (Date.now() < deadline) {
    // The unique test database excludes unrelated workers. Each observed PID is
    // a real backend currently executing its RPC while waiting on a SQL lock.
    const result = await db.query(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = 'entraide-local-test'
        AND pid <> pg_backend_pid()
        AND state = 'active' AND wait_event_type = 'Lock'
        AND strpos(query, $1) > 0
    `, [`purama_ai.${rpcName}(`]);
    observed = result.rows.map((row) => row.pid);
    if (observed.length === expected) {
      assert.equal(new Set(observed).size, expected);
      return;
    }
    await delay(25);
  }
  assert.fail(`Expected ${expected} simultaneous locked PostgreSQL clients; observed ${observed.length}`);
}

async function raceBehindLock(lockSql, lockParams, rpcName, commands) {
  let signalAcquired;
  let rejectAcquired;
  let release;
  const acquired = new Promise((resolve, reject) => { signalAcquired = resolve; rejectAcquired = reject; });
  const released = new Promise((resolve) => { release = resolve; });
  const holder = db.transaction(async (tx) => {
    await tx.query(lockSql, lockParams);
    signalAcquired();
    await released;
  });
  holder.catch(rejectAcquired);

  let pending;
  let outcomes = [];
  let failure;
  try {
    await acquired;
    pending = Promise.allSettled(commands.map((command) => command()));
    await waitForDistinctBlockedClients(rpcName, commands.length);
  } catch (error) {
    failure = error;
  } finally {
    release();
    try { await holder; } catch (error) { failure ??= error; }
    if (pending) outcomes = await pending;
  }
  if (failure) throw failure;
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  if (rejected.length) throw new AggregateError(rejected.map((outcome) => outcome.reason), 'Concurrent RPC execution failed');
  return outcomes.map((outcome) => outcome.value);
}

test('native concurrency: only one participant can take the final place', nativeOnly, async () => {
  const created = await callRpc(db, missionRpc, USERS.a, 'create', {
    id: id(1), title: 'Dernière place', min_participants: 2, max_participants: 2, visibility: 'public',
  });
  assert.equal(created.mission.revision, 0);
  const results = await raceBehindLock(
    'SELECT id FROM purama_ai.missions_collectives WHERE id=$1 FOR UPDATE', [id(1)], missionRpc,
    [USERS.b, USERS.c].map((actor) => () => callRpc(db, missionRpc, actor, 'join', { mission_id: id(1) })),
  );
  assert.equal(results.filter((result) => result.mission).length, 1);
  assert.deepEqual(results.filter((result) => result.error), [{ error: 'mission_full', status: 409 }]);
  const { mission } = await callRpc(db, missionRpc, USERS.a, 'get', { mission_id: id(1) });
  assert.equal(mission.status, 'prete');
  assert.equal(mission.revision, 1);
  assert.equal(mission.missions_collectives_participants.length, 2);
  const participants = mission.missions_collectives_participants.map((row) => row.user_id);
  assert.ok(participants.includes(USERS.a));
  assert.equal([USERS.b, USERS.c].filter((actor) => participants.includes(actor)).length, 1);
});

test('native concurrency: duplicate command IDs replay one persisted contact', nativeOnly, async () => {
  const payload = { id: id(1), recipient_id: USERS.b, message: 'Même demande' };
  const results = await raceBehindLock(
    'LOCK TABLE purama_ai.entraide_contact_requests IN SHARE MODE', [], contactRpc,
    [0, 1].map(() => () => callRpc(db, contactRpc, USERS.a, 'send', payload)),
  );
  assert.equal(results[0].request.id, id(1));
  assert.equal(results[0].request.status, 'pending');
  assert.deepEqual(results[1], results[0]);
  const stored = await db.query('SELECT id, requester_id, recipient_id, message FROM purama_ai.entraide_contact_requests');
  assert.deepEqual(stored.rows, [{ id: id(1), requester_id: USERS.a, recipient_id: USERS.b, message: 'Même demande' }]);
  assert.deepEqual(await callRpc(db, contactRpc, USERS.a, 'send', payload), results[0]);
  assert.deepEqual(await callRpc(db, contactRpc, USERS.a, 'send', { ...payload, message: 'Autre contenu' }),
    { error: 'idempotency_conflict', status: 409 });
});

test('native concurrency: one mission request has one effect and one durable receipt', nativeOnly, async () => {
  await callRpc(db, missionRpc, USERS.a, 'create', {
    id: id(1), title: 'Reprise concurrente', min_participants: 2, max_participants: 3, visibility: 'public',
  });
  const payload = { mission_id: id(1), request_id: id(2), expected_revision: 0 };
  const results = await raceBehindLock(
    'SELECT id FROM purama_ai.missions_collectives WHERE id=$1 FOR UPDATE', [id(1)], missionRpc,
    [0, 1].map(() => () => callRpc(db, missionRpc, USERS.b, 'join', payload)),
  );
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  assert.deepEqual(results[0].mission, results[1].mission);
  assert.equal(results[0].mission.revision, 1);
  assert.equal(results[0].mission.missions_collectives_participants.length, 2);
  const stored = await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_mission_requests WHERE actor_id=$1 AND request_id=$2 AND response IS NOT NULL', [USERS.b, id(2)]);
  assert.equal(stored.rows[0].n, 1);
});

test('native concurrency: simultaneous requests cannot exceed ten sends in one UTC day', nativeOnly, async () => {
  // Avoid a legitimate two-day race if a CI run starts in the last seconds of
  // a UTC day. The database clock remains real, with no clock/function stub.
  const { rows: [{ remaining }] } = await db.query(`
    SELECT extract(epoch FROM
      (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '24 hours')
      - (now() AT TIME ZONE 'UTC'))::double precision AS remaining
  `);
  if (remaining < 10) await delay(Math.ceil(remaining * 1_000) + 100);
  const payloads = Object.values(USERS).slice(1, 13).map((recipient, index) => ({
    id: id(index + 1), recipient_id: recipient, message: 'Demande simultanée',
  }));
  const results = await raceBehindLock(
    'LOCK TABLE purama_ai.entraide_contact_requests IN SHARE MODE', [], contactRpc,
    payloads.map((payload) => () => callRpc(db, contactRpc, USERS.a, 'send', payload)),
  );
  const accepted = results.filter((result) => result.request);
  assert.equal(accepted.length, 10);
  assert.deepEqual(results.filter((result) => result.error), [
    { error: 'daily_limit_reached', status: 429 }, { error: 'daily_limit_reached', status: 429 },
  ]);
  const { rows: [stored] } = await db.query(`
    SELECT count(*)::int AS count, count(DISTINCT recipient_id)::int AS recipients
    FROM purama_ai.entraide_contact_requests WHERE requester_id=$1
  `, [USERS.a]);
  assert.deepEqual(stored, { count: 10, recipients: 10 });
  const replay = payloads.find((payload) => payload.id === accepted[0].request.id);
  assert.deepEqual(await callRpc(db, contactRpc, USERS.a, 'send', replay), accepted[0]);
  assert.deepEqual(await callRpc(db, contactRpc, USERS.a, 'send', {
    id: id(13), recipient_id: USERS.n, message: 'Demande simultanée',
  }), { error: 'daily_limit_reached', status: 429 });
});
