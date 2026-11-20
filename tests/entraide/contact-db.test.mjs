import assert from 'node:assert/strict';
import test from 'node:test';
import { asRole, callRpc, createDb, seedUsers, USERS } from './db-harness.mjs';

const RPC = 'entraide_contact_command';
const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const missingUser = '10000000-0000-4000-8000-999999999999';
const error = (code, status) => ({ error: code, status });
const permissionDenied = (caught) => caught.code === '42501';

async function rpcOn(tx, actor, action, payload = {}) {
  const result = await tx.query(
    'SELECT purama_ai.entraide_contact_command($1::uuid, $2::text, $3::jsonb) AS result',
    [actor, action, JSON.stringify(payload)],
  );
  return result.rows[0].result;
}

// A real PostgreSQL session timezone with a DST end three days ago makes this
// regression deterministic throughout the year. Calendar days then differ from
// the original package's fixed 24-hour durations; the database clock is real.
async function useRecentDstEnd(tx) {
  const { rows: [{ end_day: endDay }] } = await tx.query(
    "SELECT extract(doy FROM (now() - interval '3 days') AT TIME ZONE 'UTC')::int - 1 AS end_day",
  );
  await tx.query("SELECT set_config('TimeZone', $1, true)", [
    `XST0XDT,${(endDay + 180) % 365}/0,${endDay}/0`,
  ]);
  const { rows: [duration] } = await tx.query(`
    SELECT extract(epoch FROM (now() - (now() - interval '14 days')))::int AS ttl,
           extract(epoch FROM (now() - (now() - interval '7 days')))::int AS cooldown
  `);
  assert.equal(duration.ttl, 337 * 60 * 60);
  assert.equal(duration.cooldown, 169 * 60 * 60);
}

// PGlite executes the actual migrations, RLS policies, roles and SQL function.
// It has one connection: these tests do not prove concurrent-client scheduling.
test('contact SQL protocol with real roles and persisted state', async (t) => {
  const db = await createDb();
  await seedUsers(db, Object.values(USERS));
  const run = async (name, body) => t.test(name, async () => {
    await db.exec('TRUNCATE purama_ai.entraide_contact_requests, purama_ai.entraide_blocages');
    await body();
  });
  const rpc = (actor, action, payload) => callRpc(db, RPC, actor, action, payload);
  const send = (actor, recipient, n, message) => rpc(actor, 'send', {
    id: id(n), recipient_id: recipient, ...(message === undefined ? {} : { message }),
  });
  const respond = (actor, n, response) => rpc(actor, 'respond', { request_id: id(n), response });
  const rows = async () => (await db.query(
    'SELECT * FROM purama_ai.entraide_contact_requests ORDER BY id',
  )).rows;

  try {
    await run('RPC is invoker-only, empty search_path, and executable by service_role only', async () => {
      const { rows: [definition] } = await db.query(`
        SELECT p.prosecdef, p.proconfig,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS user_execute,
          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'purama_ai' AND p.proname = 'entraide_contact_command'
      `);
      assert.equal(definition.prosecdef, false);
      assert.deepEqual(definition.proconfig, ['search_path=""']);
      assert.equal(definition.anon_execute, false);
      assert.equal(definition.user_execute, false);
      assert.equal(definition.service_execute, true);
      for (const role of ['anon', 'authenticated']) {
        await assert.rejects(asRole(db, role, USERS.a,
          "SELECT purama_ai.entraide_contact_command($1, 'list')", [USERS.b]), permissionDenied);
      }
      assert.deepEqual(await rpc(USERS.a, 'list'), { requests: [], blocked_user_ids: [] });
    });

    await run('raw client writes cannot bypass the contact or block protocol', async () => {
      await send(USERS.a, USERS.b, 1);
      await rpc(USERS.a, 'block', { target_id: USERS.c });
      const queries = [
        ["INSERT INTO purama_ai.entraide_blocages (blocker_id, blocked_id) VALUES ($1,$2)", [USERS.a, USERS.b]],
        ["DELETE FROM purama_ai.entraide_blocages WHERE blocker_id=$1", [USERS.a]],
        ["UPDATE purama_ai.entraide_blocages SET blocked_id=$1 WHERE blocker_id=$2", [USERS.b, USERS.a]],
        ["INSERT INTO purama_ai.entraide_contact_requests (requester_id,recipient_id) VALUES ($1,$2)", [USERS.a, USERS.c]],
        ["UPDATE purama_ai.entraide_contact_requests SET status='accepted' WHERE id=$1", [id(1)]],
        ["DELETE FROM purama_ai.entraide_contact_requests WHERE id=$1", [id(1)]],
      ];
      for (const [sql, params] of queries) {
        await assert.rejects(asRole(db, 'authenticated', USERS.a, sql, params), permissionDenied);
      }
      assert.equal((await rows())[0].status, 'pending');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_blocages')).rows[0].n, 1);
    });

    await run('actor, UUID, payload, message and foreign-key validation fail without writes', async () => {
      assert.deepEqual(await rpc(null, 'list'), error('invalid_actor', 403));
      assert.deepEqual(await rpc(missingUser, 'list'), error('invalid_actor', 403));
      assert.deepEqual(await rpc(USERS.a, 'unknown'), error('invalid_action', 400));
      for (const payload of [null, [], 'list', { actor_id: USERS.b }]) {
        assert.deepEqual(await rpc(USERS.a, 'list', payload), error('invalid_payload', 400));
      }
      for (const payload of [
        {}, { id: 'bad', recipient_id: USERS.b }, { id: id(1), recipient_id: 'bad' },
        { id: id(1), recipient_id: USERS.b, message: {} },
        { id: id(1), recipient_id: USERS.b, message: 'x'.repeat(501) },
        { id: id(1), recipient_id: USERS.b, requester_id: USERS.c },
      ]) {
        assert.deepEqual(await rpc(USERS.a, 'send', payload), error('invalid_payload', 400));
      }
      assert.deepEqual(await send(USERS.a, USERS.a, 1), error('self_contact', 400));
      assert.deepEqual(await send(USERS.a, missingUser, 1), error('recipient_not_found', 404));
      for (const action of ['block', 'unblock']) {
        assert.deepEqual(await rpc(USERS.a, action, { target_id: 'bad' }), error('invalid_payload', 400));
        assert.deepEqual(await rpc(USERS.a, action, { target_id: USERS.a }), error('self_contact', 400));
        assert.deepEqual(await rpc(USERS.a, action, { target_id: missingUser }), error('recipient_not_found', 404));
      }
      for (const payload of [
        {}, { request_id: 'bad', response: 'accept' }, { request_id: id(1), response: 'accepted' },
        { request_id: id(1), response: 'accept', recipient_id: USERS.a },
      ]) {
        assert.deepEqual(await rpc(USERS.a, 'respond', payload), error('invalid_payload', 400));
      }
      assert.deepEqual(await rows(), []);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_blocages')).rows[0].n, 0);
      assert.equal((await send(USERS.a, USERS.b, 1, 'x'.repeat(500))).request.message.length, 500);
    });

    await run('same id and content replay once; conflicting actor, target or message never leaks a row', async () => {
      const first = await send(USERS.a, USERS.b, 1, 'Bonjour');
      assert.equal(first.request.status, 'pending');
      assert.equal(first.request.requester_id, USERS.a);
      assert.deepEqual(await send(USERS.a, USERS.b, 1, 'Bonjour'), first);
      assert.deepEqual(await send(USERS.a, USERS.c, 1, 'Bonjour'), error('idempotency_conflict', 409));
      assert.deepEqual(await send(USERS.c, USERS.b, 1, 'Bonjour'), error('idempotency_conflict', 409));
      assert.deepEqual(await send(USERS.a, USERS.b, 1, 'Different'), error('idempotency_conflict', 409));
      assert.deepEqual(await send(USERS.a, USERS.b, 2, 'Bonjour'), error('already_pending', 409));
      assert.equal((await rows()).length, 1);
      await respond(USERS.b, 1, 'accept');
      assert.equal((await send(USERS.a, USERS.b, 1, 'Bonjour')).request.status, 'accepted');
      assert.equal((await rows()).length, 1);
    });

    await run('omitted and null messages are equivalent, an empty string is distinct', async () => {
      const first = await send(USERS.a, USERS.b, 1);
      assert.equal(first.request.message, null);
      assert.deepEqual(await send(USERS.a, USERS.b, 1, null), first);
      assert.deepEqual(await send(USERS.a, USERS.b, 1, ''), error('idempotency_conflict', 409));
    });

    await run('daily capacity allows ten sends and preserves retries when full', async () => {
      const recipients = Object.values(USERS).slice(1, 11);
      for (const [index, recipient] of recipients.entries()) {
        assert.equal((await send(USERS.a, recipient, index + 1)).request.status, 'pending');
      }
      assert.deepEqual(await send(USERS.a, USERS.l, 11), error('daily_limit_reached', 429));
      assert.equal((await send(USERS.a, USERS.b, 1)).request.id, id(1));
      assert.equal((await rows()).length, 10);
      assert.equal((await send(USERS.b, USERS.l, 12)).request.status, 'pending');
    });

    await run('quota uses complete UTC days, excluding previous and next day even in another timezone', async () => {
      await db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE service_role; SET LOCAL TIME ZONE 'Pacific/Auckland'");
        for (let n = 1; n <= 12; n += 1) {
          const offset = n <= 9 ? `${n} hours` : n === 10 ? '23 hours 59 minutes 59.999 seconds'
            : n === 11 ? '-0.001 seconds' : '24 hours';
          await tx.query(`
            INSERT INTO purama_ai.entraide_contact_requests
              (id,requester_id,recipient_id,status,created_at,responded_at)
            VALUES ($1,$2,$3,'accepted',
              (date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + $4::interval, now())
          `, [id(n), USERS.a, USERS.b, offset]);
        }
        assert.deepEqual(await rpcOn(tx, USERS.a, 'send', { id: id(13), recipient_id: USERS.c }),
          error('daily_limit_reached', 429));
        await tx.query('DELETE FROM purama_ai.entraide_contact_requests WHERE id=$1', [id(10)]);
        assert.equal((await rpcOn(tx, USERS.a, 'send', { id: id(13), recipient_id: USERS.c })).request.status, 'pending');
      });
    });

    await run('RLS and list expose only participating requests and the actor own blocks', async () => {
      await send(USERS.a, USERS.d, 1);
      await send(USERS.c, USERS.e, 2);
      await rpc(USERS.a, 'block', { target_id: USERS.b });
      await rpc(USERS.c, 'block', { target_id: USERS.a });
      const own = await rpc(USERS.a, 'list');
      assert.deepEqual(own.requests.map((request) => request.id), [id(1)]);
      assert.deepEqual(own.blocked_user_ids, [USERS.b]);
      const visibleBlocks = await asRole(db, 'authenticated', USERS.a,
        'SELECT blocker_id, blocked_id FROM purama_ai.entraide_blocages');
      assert.deepEqual(visibleBlocks.rows, [{ blocker_id: USERS.a, blocked_id: USERS.b }]);
      const visibleRequests = await asRole(db, 'authenticated', USERS.a,
        'SELECT id FROM purama_ai.entraide_contact_requests');
      assert.deepEqual(visibleRequests.rows, [{ id: id(1) }]);
      assert.deepEqual(await rpc(USERS.f, 'list'), { requests: [], blocked_user_ids: [] });
      await assert.rejects(asRole(db, 'anon', null,
        'SELECT * FROM purama_ai.entraide_contact_requests'), permissionDenied);
    });

    await run('a recipient private block is enforced; only its owner can undo it', async () => {
      assert.deepEqual(await rpc(USERS.b, 'block', { target_id: USERS.a }), { ok: true });
      assert.deepEqual((await rpc(USERS.a, 'list')).blocked_user_ids, []);
      assert.deepEqual(await send(USERS.a, USERS.b, 1), error('contact_unavailable', 403));
      assert.deepEqual(await rpc(USERS.a, 'unblock', { target_id: USERS.b }), { ok: true });
      assert.deepEqual(await send(USERS.a, USERS.b, 1), error('contact_unavailable', 403));
      assert.deepEqual(await rpc(USERS.b, 'unblock', { target_id: USERS.a }), { ok: true });
      assert.equal((await send(USERS.a, USERS.b, 1)).request.status, 'pending');
    });

    await run('only the recipient may respond, and a response cannot be overwritten', async () => {
      await send(USERS.a, USERS.b, 1);
      for (const actor of [USERS.a, USERS.c]) {
        assert.deepEqual(await respond(actor, 1, 'accept'), error('request_not_found', 404));
      }
      assert.deepEqual(await respond(USERS.b, 99, 'accept'), error('request_not_found', 404));
      assert.equal((await rows())[0].status, 'pending');
      const accepted = await respond(USERS.b, 1, 'accept');
      assert.equal(accepted.request.status, 'accepted');
      assert.ok(accepted.request.responded_at);
      for (const response of ['accept', 'decline', 'block']) {
        assert.deepEqual(await respond(USERS.b, 1, response), error('request_not_pending', 409));
      }
      assert.equal((await rows())[0].status, 'accepted');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_blocages')).rows[0].n, 0);
    });

    await run('declining starts a pair-specific cooldown without penalising another recipient', async () => {
      await send(USERS.a, USERS.b, 1);
      assert.equal((await respond(USERS.b, 1, 'decline')).request.status, 'declined');
      assert.deepEqual(await send(USERS.a, USERS.b, 2), error('cooldown_active', 429));
      assert.equal((await send(USERS.a, USERS.c, 2)).request.status, 'pending');
      assert.equal((await rows()).length, 2);
    });

    await run('TTL expires at exactly 336 hours across DST and commits expiry despite a business error', async () => {
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await useRecentDstEnd(tx);
        await tx.query(`
          INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id,created_at)
          VALUES ($1,$2,$3,now()-interval '336 hours')
        `, [id(1), USERS.a, USERS.b]);
        assert.deepEqual(await rpcOn(tx, USERS.b, 'respond', { request_id: id(1), response: 'accept' }),
          error('request_expired', 409));
      });
      const { rows: [expired] } = await db.query(`
        SELECT status, extract(epoch FROM responded_at-created_at)::int AS duration
        FROM purama_ai.entraide_contact_requests WHERE id=$1
      `, [id(1)]);
      assert.deepEqual(expired, { status: 'expired', duration: 336 * 60 * 60 });
      assert.deepEqual(await respond(USERS.b, 1, 'block'), error('request_expired', 409));
      assert.equal((await send(USERS.a, USERS.b, 1)).request.status, 'expired');
      assert.deepEqual(await send(USERS.a, USERS.b, 2), error('cooldown_active', 429));
    });

    await run('a request one millisecond before the TTL boundary may still be accepted', async () => {
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await tx.query(`
          INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id,created_at)
          VALUES ($1,$2,$3,now()-interval '336 hours'+interval '1 millisecond')
        `, [id(1), USERS.a, USERS.b]);
        assert.equal((await rpcOn(tx, USERS.b, 'respond', { request_id: id(1), response: 'accept' })).request.status, 'accepted');
      });
    });

    await run('listing expires the actor pending requests only and preserves accepted consent', async () => {
      await db.query(`
        INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id,status,created_at)
        VALUES ($1,$4,$5,'pending',now()-interval '400 hours'),
               ($2,$6,$7,'pending',now()-interval '400 hours'),
               ($3,$4,$5,'accepted',now()-interval '401 hours')
      `, [id(1), id(2), id(3), USERS.a, USERS.b, USERS.c, USERS.d]);
      const listed = await rpc(USERS.b, 'list');
      assert.deepEqual(listed.requests.map((request) => [request.id, request.status]), [
        [id(1), 'expired'], [id(3), 'accepted'],
      ]);
      assert.deepEqual((await rows()).map((request) => request.status), ['expired', 'pending', 'accepted']);
    });

    await run('cooldown ends at exactly 168 hours across DST, not one millisecond earlier', async () => {
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await useRecentDstEnd(tx);
        await tx.query(`
          INSERT INTO purama_ai.entraide_contact_requests
            (id,requester_id,recipient_id,status,created_at,responded_at)
          VALUES ($1,$4,$5,'declined',now()-interval '180 hours',now()-interval '168 hours'+interval '1 millisecond'),
                 ($2,$4,$6,'declined',now()-interval '180 hours',now()-interval '168 hours'),
                 ($3,$4,$7,'expired',now()-interval '504 hours',now()-interval '168 hours')
        `, [id(1), id(2), id(3), USERS.a, USERS.b, USERS.c, USERS.d]);
        assert.deepEqual(await rpcOn(tx, USERS.a, 'send', { id: id(4), recipient_id: USERS.b }), error('cooldown_active', 429));
        assert.equal((await rpcOn(tx, USERS.a, 'send', { id: id(5), recipient_id: USERS.c })).request.status, 'pending');
        assert.equal((await rpcOn(tx, USERS.a, 'send', { id: id(6), recipient_id: USERS.d })).request.status, 'pending');
      });
    });

    await run('lazy expiry uses its original deadline for cooldown instead of the observation time', async () => {
      await db.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE service_role');
        await tx.query(`
          INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id,created_at)
          VALUES ($1,$3,$4,now()-interval '360 hours'), ($2,$3,$5,now()-interval '504 hours')
        `, [id(1), id(2), USERS.a, USERS.b, USERS.c]);
        assert.deepEqual(await rpcOn(tx, USERS.a, 'send', { id: id(3), recipient_id: USERS.b }), error('cooldown_active', 429));
        assert.equal((await rpcOn(tx, USERS.a, 'send', { id: id(4), recipient_id: USERS.c })).request.status, 'pending');
        const { rows: expired } = await tx.query(`
          SELECT id,status,extract(epoch FROM responded_at-created_at)::int AS duration
          FROM purama_ai.entraide_contact_requests WHERE id IN ($1,$2) ORDER BY id
        `, [id(1), id(2)]);
        assert.deepEqual(expired, [
          { id: id(1), status: 'expired', duration: 336 * 60 * 60 },
          { id: id(2), status: 'expired', duration: 336 * 60 * 60 },
        ]);
      });
    });

    await run('incomplete historical refusal timestamps fail closed', async () => {
      await db.query(`
        INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id,status)
        VALUES ($1,$3,$4,'declined'), ($2,$3,$5,'expired')
      `, [id(1), id(2), USERS.a, USERS.b, USERS.c]);
      assert.deepEqual(await send(USERS.a, USERS.b, 3), error('contact_history_unavailable', 409));
      assert.deepEqual(await send(USERS.a, USERS.c, 4), error('contact_history_unavailable', 409));
      assert.equal((await rows()).length, 2);
    });

    await run('blocking atomically revokes pending and accepted requests in both directions', async () => {
      await send(USERS.a, USERS.b, 1);
      await send(USERS.b, USERS.a, 2);
      await db.query(`
        INSERT INTO purama_ai.entraide_contact_requests(id,requester_id,recipient_id,status,responded_at)
        VALUES ($1,$4,$5,'accepted',now()), ($2,$4,$5,'declined',now()), ($3,$5,$4,'expired',now())
      `, [id(3), id(4), id(5), USERS.a, USERS.b]);
      assert.deepEqual(await rpc(USERS.b, 'block', { target_id: USERS.a }), { ok: true });
      assert.deepEqual((await rows()).map((request) => request.status), ['blocked', 'blocked', 'blocked', 'declined', 'expired']);
      assert.deepEqual((await rpc(USERS.b, 'list')).blocked_user_ids, [USERS.a]);
      assert.deepEqual(await rpc(USERS.b, 'block', { target_id: USERS.a }), { ok: true });
      assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_blocages')).rows[0].n, 1);
      assert.deepEqual(await rpc(USERS.b, 'unblock', { target_id: USERS.a }), { ok: true });
      assert.deepEqual((await rpc(USERS.b, 'list')).blocked_user_ids, []);
      assert.deepEqual((await rows()).map((request) => request.status), ['blocked', 'blocked', 'blocked', 'declined', 'expired']);
    });

    await run('a block response returns the persisted blocked request and closes the reverse request', async () => {
      await send(USERS.a, USERS.b, 1);
      await send(USERS.b, USERS.a, 2);
      const result = await respond(USERS.b, 1, 'block');
      assert.equal(result.request.id, id(1));
      assert.equal(result.request.status, 'blocked');
      assert.ok(result.request.responded_at);
      assert.deepEqual((await rows()).map((request) => request.status), ['blocked', 'blocked']);
      assert.deepEqual((await rpc(USERS.b, 'list')).blocked_user_ids, [USERS.a]);
      assert.deepEqual(await send(USERS.a, USERS.b, 3), error('contact_unavailable', 403));
    });

    await run('an existing legacy block cannot be bypassed by accepting a pending request', async () => {
      await send(USERS.a, USERS.b, 1);
      await db.query('INSERT INTO purama_ai.entraide_blocages(blocker_id,blocked_id) VALUES ($1,$2)', [USERS.a, USERS.b]);
      assert.deepEqual(await respond(USERS.b, 1, 'accept'), error('contact_unavailable', 403));
      assert.equal((await rows())[0].status, 'pending');
    });

    await run('a block insertion failure is surfaced and cannot acknowledge a successful block', async () => {
      await send(USERS.a, USERS.b, 1);
      await db.exec(`
        CREATE FUNCTION purama_ai.test_reject_contact_block() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected block insertion failure'; END $$;
        CREATE TRIGGER test_reject_contact_block BEFORE INSERT ON purama_ai.entraide_blocages
        FOR EACH ROW EXECUTE FUNCTION purama_ai.test_reject_contact_block();
      `);
      try {
        await assert.rejects(respond(USERS.b, 1, 'block'),
          (caught) => caught.code === 'P0001' && caught.message.includes('injected block insertion failure'));
        assert.equal((await rows())[0].status, 'pending');
        assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_blocages')).rows[0].n, 0);
      } finally {
        await db.exec('DROP TRIGGER test_reject_contact_block ON purama_ai.entraide_blocages; DROP FUNCTION purama_ai.test_reject_contact_block()');
      }
      assert.equal((await respond(USERS.b, 1, 'block')).request.status, 'blocked');
    });

    await run('a request update failure rolls back a block already inserted in the command', async () => {
      await send(USERS.a, USERS.b, 1);
      await db.exec(`
        CREATE FUNCTION purama_ai.test_reject_contact_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status = 'blocked' THEN RAISE EXCEPTION 'injected request update failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_reject_contact_update BEFORE UPDATE ON purama_ai.entraide_contact_requests
        FOR EACH ROW EXECUTE FUNCTION purama_ai.test_reject_contact_update();
      `);
      try {
        await assert.rejects(respond(USERS.b, 1, 'block'),
          (caught) => caught.code === 'P0001' && caught.message.includes('injected request update failure'));
        assert.equal((await rows())[0].status, 'pending');
        assert.equal((await db.query('SELECT count(*)::int AS n FROM purama_ai.entraide_blocages')).rows[0].n, 0);
      } finally {
        await db.exec('DROP TRIGGER test_reject_contact_update ON purama_ai.entraide_contact_requests; DROP FUNCTION purama_ai.test_reject_contact_update()');
      }
    });
  } finally {
    await db.close();
  }
});
