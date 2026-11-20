import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEntraideHandler } from '../../supabase/functions/_shared/entraide-http.ts';
import { createSupabaseEntraidePorts } from '../../supabase/functions/_shared/entraide-supabase.ts';
import { createDb, seedUsers, callRpc, USERS } from './db-harness.mjs';

let db;
before(async () => { db = await createDb(); await seedUsers(db, Object.values(USERS)); });
after(async () => { await db?.close(); });

function ports(overrides = {}) {
  return {
    authenticate: async header => header === 'Bearer invalid' ? null : { id: header.slice(7) },
    getProfile: async actor => ({ user_id: actor, skills_offered: [] }),
    saveProfile: async () => {}, getMatches: async () => ({ matches: [] }),
    command: (kind, actor, action, payload) => callRpc(db, `entraide_${kind}_command`, actor, action, payload),
    ...overrides,
  };
}
function request(route, { actor = USERS.a, method = 'GET', body, headers = {} } = {}) {
  return new Request(`https://example.test/functions/v1/${route}`, {
    method, headers: { Authorization: `Bearer ${actor}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
async function invoke(route, options, dependencies) {
  const response = await createEntraideHandler(route.split('/')[0], dependencies ?? ports())(request(route, options));
  return { status: response.status, data: await response.json(), headers: response.headers };
}

test('HTTP responses use numeric status; preflight, no-store, auth and methods remain usable', async () => {
  const handler = createEntraideHandler('entraide-profil', ports());
  const preflight = await handler(request('entraide-profil', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, PUT, OPTIONS');
  assert.equal((await invoke('entraide-profil', { actor: 'invalid' })).status, 401);
  assert.equal((await invoke('entraide-profil', { headers: { Authorization: '' } })).status, 401);
  const method = await invoke('entraide-profil', { method: 'DELETE' });
  assert.equal(method.status, 405); assert.equal(method.headers.get('Allow'), 'GET, PUT, OPTIONS');
  const own = await invoke('entraide-profil', {});
  assert.equal(own.status, 200); assert.equal(own.data.profil.user_id, USERS.a);
  assert.equal(own.headers.get('Cache-Control'), 'no-store');
});

test('Malformed, oversized, foreign-owner and incomplete-coordinate writes are rejected before persistence', async () => {
  let writes = 0;
  const dependencies = ports({ saveProfile: async () => { writes++; } });
  for (const [body, status] of [
    ['{', 400], [[], 400], [{ user_id: USERS.b }, 400], [{ location_lat: 2 }, 400],
    [{ availability_days: ['bad'] }, 400], [{ radius_km: -1 }, 400],
    [{ skills_offered: ['a'.repeat(101)] }, 400], [' '.repeat(16_385), 413],
  ]) {
    const result = await invoke('entraide-profil', { actor: USERS.b, method: 'PUT', body }, dependencies);
    assert.equal(result.status, status, JSON.stringify(body).slice(0, 100));
  }
  assert.equal(writes, 0);
  const success = await invoke('entraide-profil', { actor: USERS.b, method: 'PUT', body: { skills_offered: [' aider ', 'aider'], location_lat: null, location_lng: null } }, {
    ...dependencies, saveProfile: async (actor, value) => { assert.equal(actor, USERS.b); assert.deepEqual(value.skills_offered, ['aider']); writes++; },
  });
  assert.equal(success.status, 200); assert.equal(writes, 1);
});

test('Exact routes do not let suffixes reach list or mutate resources', async () => {
  let calls = 0;
  const dependencies = ports({ command: async () => { calls++; return { requests: [] }; } });
  for (const route of ['entraide-contact/extra', `entraide-contact/${USERS.a}/respond/extra`, 'entraide-missions/no-id/join', 'entraide-profil/extra']) {
    assert.equal((await invoke(route, {}, dependencies)).status, 404);
  }
  assert.equal(calls, 0);
});

test('Burst limiter uses the real shared limiter and returns 429 before a 21st profile write', async () => {
  const actor = randomUUID(); let writes = 0;
  const dependencies = ports({ saveProfile: async () => { writes++; } });
  for (let i = 0; i < 20; i++) assert.equal((await invoke('entraide-profil', { actor, method: 'PUT', body: { skills_needed: [] } }, dependencies)).status, 200);
  const refused = await invoke('entraide-profil', { actor, method: 'PUT', body: { skills_needed: [] } }, dependencies);
  assert.equal(refused.status, 429); assert.equal(refused.headers.get('Retry-After'), '60'); assert.equal(writes, 20);
});

test('Storage and auth outages, and malformed RPC output, never produce success or expose raw errors', async () => {
  for (const dependencies of [ports({ getProfile: async () => { throw new Error('private SQL password'); } }), ports({ authenticate: async () => { throw new Error('secret key'); } })]) {
    const result = await invoke('entraide-profil', {}, dependencies);
    assert.equal(result.status, 503); assert.deepEqual(result.data, { error: 'service_unavailable' });
  }
  for (const response of [null, {}, { requests: null }, { error: 'raw SQL secret', status: 400 }]) {
    assert.equal((await invoke('entraide-contact', {}, ports({ command: async () => response }))).status, 503);
  }
});

test('HTTP→PostgreSQL lifecycle: private by default, no outsider read, replay-safe public creation, owner revisions and terminal state', async () => {
  const privateId = randomUUID();
  const base = { id: privateId, title: 'Premier pas', description: 'Un résultat utile', min_participants: 2, max_participants: 2 };
  const privateMission = await invoke('entraide-missions', { method: 'POST', body: base });
  assert.equal(privateMission.status, 200); assert.equal(privateMission.data.mission.visibility, 'private');
  assert.equal((await invoke(`entraide-missions/${privateId}`, { actor: USERS.c })).status, 404);
  const id = randomUUID(); const publicBody = { ...base, id, visibility: 'public' };
  assert.equal((await invoke('entraide-missions', { method: 'POST', body: publicBody })).status, 200);
  assert.equal((await invoke('entraide-missions', { method: 'POST', body: publicBody })).status, 200);
  const joined = await invoke(`entraide-missions/${id}/join`, { actor: USERS.b, method: 'POST', body: {} });
  assert.equal(joined.data.mission.status, 'prete'); assert.equal(joined.data.mission.revision, 1);
  assert.equal((await invoke(`entraide-missions/${id}/join`, { actor: USERS.c, method: 'POST', body: {} })).status, 409);
  assert.equal((await invoke(`entraide-missions/${id}/start`, { actor: USERS.b, method: 'POST', body: { expected_revision: 1 } })).status, 403);
  assert.equal((await invoke(`entraide-missions/${id}/start`, { method: 'POST', body: { expected_revision: 0 } })).status, 409);
  const started = await invoke(`entraide-missions/${id}/start`, { method: 'POST', body: { expected_revision: 1 } });
  assert.equal(started.data.mission.status, 'en_cours');
  const complete = await invoke(`entraide-missions/${id}/complete`, { method: 'POST', body: { expected_revision: 2 } });
  assert.equal(complete.data.mission.status, 'terminee'); assert.equal(complete.data.mission.revision, 3);
  assert.equal((await invoke(`entraide-missions/${id}/join`, { actor: USERS.c, method: 'POST', body: {} })).status, 409);
  const count = await db.query('SELECT count(*) AS n FROM purama_ai.missions_collectives WHERE id = $1', [id]);
  assert.equal(Number(count.rows[0].n), 1);
});

test('HTTP→PostgreSQL contacts: stable send, recipient-only response, accepted-channel revocation and private block list', async () => {
  const id = randomUUID(); const body = { id, recipient_id: USERS.e, message: 'Bonjour' };
  assert.equal((await invoke('entraide-contact', { actor: USERS.d, method: 'POST', body })).status, 200);
  assert.equal((await invoke('entraide-contact', { actor: USERS.d, method: 'POST', body })).data.request.id, id);
  assert.equal((await invoke(`entraide-contact/${id}/respond`, { actor: USERS.f, method: 'POST', body: { response: 'accept' } })).status, 404);
  assert.equal((await invoke(`entraide-contact/${id}/respond`, { actor: USERS.e, method: 'POST', body: { response: 'accept' } })).data.request.status, 'accepted');
  assert.equal((await invoke('entraide-contact/block', { actor: USERS.e, method: 'POST', body: { target_id: USERS.d } })).status, 200);
  const recipient = await invoke('entraide-contact', { actor: USERS.e });
  assert.equal(recipient.data.requests.find(r => r.id === id).status, 'blocked');
  assert.deepEqual(recipient.data.blocked_user_ids, [USERS.d]);
  assert.deepEqual((await invoke('entraide-contact', { actor: USERS.d })).data.blocked_user_ids, []);
  await invoke('entraide-contact/unblock', { actor: USERS.e, method: 'POST', body: { target_id: USERS.d } });
  assert.equal((await invoke('entraide-contact', { actor: USERS.e })).data.requests.find(r => r.id === id).status, 'blocked');
});

function databaseFixture({ profiles = [], blocks = [], failure } = {}) {
  const calls = [];
  const own = { user_id: USERS.h, skills_offered: ['cuisine'], skills_needed: ['code'], availability_days: ['mon'], radius_km: null, location_lat: 48, location_lng: 2 };
  const client = {
    from(table) {
      const call = { table, steps: [] }; calls.push(call);
      const query = {
        select(columns) { call.steps.push(['select', columns]); return query; },
        eq(...args) { call.steps.push(['eq', ...args]); return query; },
        neq(...args) { call.steps.push(['neq', ...args]); return query; },
        order(...args) { call.steps.push(['order', ...args]); return query; },
        limit(...args) { call.steps.push(['limit', ...args]); return query; },
        or(...args) { call.steps.push(['or', ...args]); return query; },
        maybeSingle() { return Promise.resolve({ data: own, error: failure === 'own' ? new Error('private') : null }); },
        then(resolve, reject) { return Promise.resolve({ data: table === 'entraide_blocages' ? blocks : profiles, error: failure === table ? new Error('private') : null }).then(resolve, reject); },
      };
      return query;
    },
  };
  return { calls, own, ports: createSupabaseEntraidePorts({ serviceClient: () => client, authenticatedClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: USERS.h } }, error: null }) } }) }) };
}

test('Supabase adapter scopes own coordinates, batches both block directions and exports no coordinate or block list', async () => {
  const profile = id => ({ user_id: id, skills_offered: ['code'], skills_needed: ['cuisine'], availability_days: ['mon'], radius_km: null, location_lat: 1, location_lng: 2 });
  const fixture = databaseFixture({ profiles: [profile(USERS.i), profile(USERS.j), profile(USERS.k)], blocks: [
    { blocker_id: USERS.i, blocked_id: USERS.h }, { blocker_id: USERS.h, blocked_id: USERS.j },
  ] });
  const result = await fixture.ports.getMatches(USERS.h);
  assert.deepEqual(result.matches.map(m => m.userId), [USERS.k]);
  assert.equal(fixture.calls.length, 3, 'one profile lookup, one candidate batch, one bidirectional block batch');
  assert.ok(fixture.calls[0].steps.some(step => step[0] === 'eq' && step[1] === 'user_id' && step[2] === USERS.h));
  assert.ok(fixture.calls[2].steps.some(step => step[0] === 'or' && step[1].includes(`blocked_id.eq.${USERS.h}`)));
  assert.doesNotMatch(JSON.stringify(result), /location_|blockedUserIds|blocker_id/);
  for (const failure of ['own', 'entraide_profils', 'entraide_blocages']) {
    await assert.rejects(() => databaseFixture({ failure }).ports.getMatches(USERS.h));
  }
});

test('Bounded matching explicitly marks incomplete scans', async () => {
  const profiles = Array.from({ length: 501 }, () => ({ user_id: randomUUID(), skills_offered: ['code'], skills_needed: [], availability_days: [], radius_km: null, location_lat: null, location_lng: null }));
  const result = await databaseFixture({ profiles }).ports.getMatches(USERS.h);
  assert.equal(result.truncated, true); assert.equal(result.scanned_profiles, 500); assert.equal(result.matches.length, 500);
});
