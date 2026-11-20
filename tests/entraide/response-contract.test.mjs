import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEntraideHandler } from '../../supabase/functions/_shared/entraide-http.ts';

// Boundary tests use synthetic ports. They do not assert live authentication,
// database concurrency, deployment or independent proof of a mission's result.
const MISSION_ID = 'abcdabcd-0000-4000-8000-000000000001';
const OTHER_ID = 'abcdabcd-0000-4000-8000-000000000002';
const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const CREATED = '2026-11-10T09:00:00.123456+00:00';
const UPDATED = '2026-11-10T10:00:00.000Z';
let callerSequence = 100;

function mission(overrides = {}) {
  return {
    id: MISSION_ID, organizer_id: USER_A, title: 'Réalisation collective', description: '',
    min_participants: 2, max_participants: null, status: 'ouverte', revision: 0, visibility: 'private',
    created_at: CREATED, updated_at: UPDATED,
    missions_collectives_participants: [{ user_id: USER_A, joined_at: CREATED }],
    ...overrides,
  };
}

function contact(overrides = {}) {
  return {
    id: MISSION_ID, requester_id: USER_A, recipient_id: USER_B, status: 'pending',
    message: null, created_at: CREATED, responded_at: null, ...overrides,
  };
}

async function invoke(route, path, data, method = 'GET', body) {
  // Independent callers keep the worker-local rate limiter out of DTO tests.
  const actor = `10000000-0000-4000-8000-${String(++callerSequence).padStart(12, '0')}`;
  const ports = {
    authenticate: async () => ({ id: actor }),
    getProfile: async () => null,
    saveProfile: async () => {},
    getMatches: async () => data,
    command: async () => data,
  };
  const req = new Request(`https://local.test/${route}${path}`, {
    method,
    headers: { Authorization: 'Bearer synthetic-token', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await createEntraideHandler(route, ports)(req);
  return { status: response.status, body: await response.json() };
}

const getMission = (data, path = `/${MISSION_ID}`) => invoke('entraide-missions', path, data);
const unavailable = (result) => assert.deepEqual(result, { status: 503, body: { error: 'service_unavailable' } });

test('an empty or malformed mission can never produce the previously reproduced false HTTP 200', async () => {
  for (const data of [{ mission: {} }, { mission: null }, { mission: [] }, {}, null, [], 'raw secret']) {
    unavailable(await getMission(data));
  }
});

test('valid mission output is whitelisted at the envelope, row and participant levels', async () => {
  const expected = mission();
  const raw = mission({
    initial_visibility: 'private', secret: 'storage detail',
    missions_collectives_participants: [{ user_id: USER_A, joined_at: CREATED, private_location: [1, 2] }],
  });
  assert.deepEqual(await getMission({ mission: raw, diagnostic: 'credential' }), {
    status: 200, body: { mission: expected },
  });
});

test('mission get, lifecycle and creation responses must match the route or stable creation ID', async () => {
  unavailable(await getMission({ mission: mission({ id: OTHER_ID }) }));
  unavailable(await invoke('entraide-missions', `/${MISSION_ID}/join`, { mission: mission({ id: OTHER_ID }) }, 'POST', {}));
  unavailable(await invoke('entraide-missions', `/${MISSION_ID}/publish`, { mission: mission({ id: OTHER_ID }) }, 'POST', { expected_revision: 0 }));
  const input = { id: MISSION_ID, title: 'Projet', description: '', min_participants: 2 };
  unavailable(await invoke('entraide-missions', '', { mission: mission({ id: OTHER_ID }) }, 'POST', input));
  assert.equal((await getMission({ mission: mission() }, `/${MISSION_ID.toUpperCase()}`)).status, 200);
  assert.equal((await invoke('entraide-missions', '', { mission: mission() }, 'POST', { ...input, id: MISSION_ID.toUpperCase() })).status, 200);
});

test('mission identifiers, state, revisions, visibility, bounds and timestamps must be valid', async () => {
  const invalid = [
    { id: 'invalid' }, { organizer_id: null }, { title: 1 }, { description: null },
    { status: 'completed' }, { status: ['ouverte'] },
    { revision: -1 }, { revision: 1.2 }, { revision: '0' }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { visibility: 'all' }, { visibility: null },
    { min_participants: 1 }, { min_participants: 2.5 }, { min_participants: 2_147_483_648 },
    { max_participants: 1 }, { max_participants: undefined }, { max_participants: 2.5 },
    { created_at: '2026-11-10' }, { created_at: '2026-02-30T10:00:00Z' },
    { updated_at: '2026-11-10T10:00:00' }, { updated_at: '2026-11-10T24:00:00Z' },
    { missions_collectives_participants: null }, { missions_collectives_participants: {} },
  ];
  for (const change of invalid) unavailable(await getMission({ mission: mission(change) }));
  assert.equal((await getMission({ mission: mission({ max_participants: 2, revision: Number.MAX_SAFE_INTEGER }) })).status, 200);
});

test('participants have valid identifiers and join dates while historical rows remain readable', async () => {
  for (const member of [null, 'member', {}, { user_id: 'bad', joined_at: CREATED }, { user_id: USER_A, joined_at: null }]) {
    unavailable(await getMission({ mission: mission({ missions_collectives_participants: [member] }) }));
  }
  // A read cannot require the organizer or current quorum to appear in old data.
  const legacy = mission({ status: 'prete', missions_collectives_participants: [{ user_id: USER_B, joined_at: CREATED }] });
  assert.deepEqual(await getMission({ mission: legacy }), { status: 200, body: { mission: legacy } });
  assert.equal((await getMission({ mission: mission({ status: 'en_cours', missions_collectives_participants: [] }) })).status, 200);
});

test('mission lists validate every row and discard unrelated response data', async () => {
  for (const data of [{ missions: {} }, { missions: [mission(), {}] }, { missions: [null] }]) {
    unavailable(await getMission(data, ''));
  }
  assert.deepEqual(await getMission({ missions: [], secret: 'hidden' }, ''), { status: 200, body: { missions: [] } });
  assert.deepEqual(await getMission({ missions: [mission({ secret: 'hidden' })] }, ''), {
    status: 200, body: { missions: [mission()] },
  });
});

test('contact responses validate known states and expose only the stored DTO contract', async () => {
  for (const status of ['pending', 'accepted', 'declined', 'expired', 'blocked']) {
    const row = contact({ status, message: 'Bonjour', responded_at: status === 'pending' ? null : UPDATED });
    assert.deepEqual(await invoke('entraide-contact', '', { request: { ...row, diagnostic: 'hidden' }, secret: 'hidden' }, 'POST', {
      id: MISSION_ID, recipient_id: USER_B,
    }), { status: 200, body: { request: row } });
  }
});

test('malformed contacts never escape through send or list responses', async () => {
  const invalid = [
    {}, null, [], contact({ id: 'bad' }), contact({ requester_id: 'bad' }), contact({ recipient_id: null }),
    contact({ status: 'approved' }), contact({ status: ['pending'] }),
    contact({ message: {} }), contact({ message: undefined }),
    contact({ created_at: 'yesterday' }), contact({ responded_at: undefined }), contact({ responded_at: '2026-02-29T00:00:00Z' }),
  ];
  for (const row of invalid) {
    unavailable(await invoke('entraide-contact', '', { request: row }, 'POST', { id: MISSION_ID, recipient_id: USER_B }));
  }
  unavailable(await invoke('entraide-contact', '', { requests: [contact(), {}], blocked_user_ids: [] }));
});

test('contact send and response outcomes must match their creation or route ID', async () => {
  unavailable(await invoke('entraide-contact', '', { request: contact({ id: OTHER_ID }) }, 'POST', { id: MISSION_ID, recipient_id: USER_B }));
  unavailable(await invoke('entraide-contact', `/${MISSION_ID}/respond`, { request: contact({ id: OTHER_ID }) }, 'POST', { response: 'accept' }));
  assert.equal((await invoke('entraide-contact', `/${MISSION_ID.toUpperCase()}/respond`, { request: contact() }, 'POST', { response: 'decline' })).status, 200);
});

test('contact lists validate all block IDs and block commands return a strict success shape', async () => {
  for (const blocked_user_ids of [undefined, null, {}, ['bad'], [USER_A, 42]]) {
    unavailable(await invoke('entraide-contact', '', { requests: [], blocked_user_ids }));
  }
  assert.deepEqual(await invoke('entraide-contact', '', {
    requests: [contact({ extra: 'hidden' })], blocked_user_ids: [USER_B], extra: 'hidden',
  }), { status: 200, body: { requests: [contact()], blocked_user_ids: [USER_B] } });
  for (const action of ['block', 'unblock']) {
    assert.deepEqual(await invoke('entraide-contact', `/${action}`, { ok: true, raw: 'hidden' }, 'POST', { target_id: USER_B }),
      { status: 200, body: { ok: true } });
    unavailable(await invoke('entraide-contact', `/${action}`, { ok: false }, 'POST', { target_id: USER_B }));
  }
});

test('matching results validate user IDs, bounded finite scores, reasons and optional scan metadata', async () => {
  const valid = { userId: USER_B, score: 75.5, reasons: ['Compétence recherchée'] };
  const invalid = [
    {}, null, { ...valid, userId: 'bad' }, { ...valid, score: -1 }, { ...valid, score: 101 },
    { ...valid, score: NaN }, { ...valid, score: Infinity }, { ...valid, score: '75' },
    { ...valid, reasons: 'reason' }, { ...valid, reasons: [1] },
  ];
  for (const row of invalid) unavailable(await invoke('entraide-matches', '', { matches: [row] }));
  for (const metadata of [{ scanned_profiles: -1 }, { scanned_profiles: '1' }, { truncated: 'yes' }]) {
    unavailable(await invoke('entraide-matches', '', { matches: [valid], ...metadata }));
  }
  assert.deepEqual(await invoke('entraide-matches', '', {
    matches: [{ ...valid, location_lat: 1, blockedUserIds: [USER_A] }], scanned_profiles: 10, truncated: false, credential: 'hidden',
  }), { status: 200, body: { matches: [valid], scanned_profiles: 10, truncated: false } });
  for (const score of [0, 100]) assert.equal((await invoke('entraide-matches', '', { matches: [{ ...valid, score }] })).status, 200);
});

test('business errors are preserved safely and malformed errors become generic 503 responses', async () => {
  for (const status of [400, 403, 404, 409, 410, 429]) {
    assert.deepEqual(await getMission({ error: 'mission_not_found', status, details: 'credential', mission: mission() }),
      { status, body: { error: 'mission_not_found' } });
  }
  for (const data of [
    { error: 'raw SQL error / credential', status: 409 }, { error: {}, status: 409 },
    { error: 'conflict', status: '409' }, { error: 'conflict', status: 200 }, { error: 'conflict' },
  ]) unavailable(await getMission(data));
});
