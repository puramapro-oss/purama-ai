import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { createEntraideHandler } from '../../supabase/functions/_shared/entraide-http.ts';
import { createSupabaseEntraidePorts } from '../../supabase/functions/_shared/entraide-supabase.ts';

// Only the HTTP response boundary is substituted. Queries, serialization,
// headers, maybeSingle/upsert/RPC and auth.getUser execute the installed SDK.
// No SQL engine, credentials, remote provider or query-builder doubles are used.
const require = createRequire(import.meta.url);
const sdkVersion = require('@supabase/supabase-js/package.json').version;
const ORIGIN = 'https://entraide-sdk.invalid';
const ACTOR = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const REQUEST_ID = '20000000-0000-4000-8000-000000000001';
const ANON_KEY = 'synthetic-anon-key-not-a-secret';
const SERVICE_KEY = 'synthetic-service-key-not-a-secret';
const STAMP = '2026-11-10T12:00:00.000Z';
const PROFILE = {
  user_id: ACTOR, skills_offered: ['écoute'], skills_needed: ['jardinage'],
  availability_days: ['mon'], radius_km: 20, location_lat: 48, location_lng: 2,
  created_at: STAMP, updated_at: STAMP,
};
const USER = { id: ACTOR, aud: 'authenticated', created_at: STAMP, app_metadata: {}, user_metadata: {} };
const realFetch = globalThis.fetch;

before(() => {
  // A future SDK path that ignores the explicitly supplied fetch must fail here
  // rather than perform any external network request.
  globalThis.fetch = async () => { throw new Error('external_network_forbidden_in_sdk_test'); };
});
after(() => { globalThis.fetch = realFetch; });

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fixture(reply) {
  const calls = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, ORIGIN);
    assert.ok(url.pathname.startsWith('/rest/v1/') || url.pathname === '/auth/v1/user');
    const text = await request.text();
    const call = { url, method: request.method, headers: request.headers, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  const client = (key, headers = {}) => createClient(ORIGIN, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: 'purama_ai' },
    global: { fetch, headers },
  });
  const service = client(SERVICE_KEY);
  return {
    calls,
    ports: createSupabaseEntraidePorts({
      serviceClient: () => service,
      authenticatedClient: (header) => client(ANON_KEY, { Authorization: header }),
    }),
  };
}

function providerError(status = 403) {
  return jsonResponse({ code: '42501', message: 'synthetic provider detail', details: null, hint: null }, status);
}

test('SDK 2.91.0 builds a profile GET scoped by actor and purama_ai schema', async () => {
  assert.equal(sdkVersion, '2.91.0');
  const { calls, ports } = fixture(() => jsonResponse([PROFILE]));
  assert.deepEqual(await ports.getProfile(ACTOR), PROFILE);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'GET');
  assert.equal(call.url.pathname, '/rest/v1/entraide_profils');
  assert.equal(call.url.searchParams.get('user_id'), `eq.${ACTOR}`);
  assert.deepEqual(new Set(call.url.searchParams.get('select').split(',')), new Set(Object.keys(PROFILE)));
  assert.equal(call.headers.get('Accept-Profile'), 'purama_ai');
  assert.equal(call.headers.get('Authorization'), `Bearer ${SERVICE_KEY}`);
  assert.equal(call.headers.get('apikey'), SERVICE_KEY);
  assert.equal(call.body, undefined);
});

test('real maybeSingle handles absence and prevents a provider row from changing the actor scope', async () => {
  const empty = fixture(() => jsonResponse([]));
  assert.equal(await empty.ports.getProfile(ACTOR), null);
  assert.equal(empty.calls.length, 1);
  const wrongOwner = fixture(() => jsonResponse([{ ...PROFILE, user_id: OTHER }]));
  await assert.rejects(wrongOwner.ports.getProfile(ACTOR), { message: 'profile_scope_mismatch' });
  const duplicate = fixture(() => jsonResponse([PROFILE, PROFILE]));
  await assert.rejects(duplicate.ports.getProfile(ACTOR), { message: 'profile_read_failed' });
});

test('real upsert posts one array row, pins its actor and requests defaults for omitted fields', async () => {
  const { calls, ports } = fixture(() => new Response(null, { status: 201 }));
  const payload = Object.freeze({ skills_offered: ['écoute'], user_id: OTHER, updated_at: 'untrusted-time' });
  const started = Date.now();
  await ports.saveProfile(ACTOR, payload);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.url.pathname, '/rest/v1/entraide_profils');
  assert.equal(call.url.searchParams.get('on_conflict'), 'user_id');
  assert.equal(call.headers.get('Content-Profile'), 'purama_ai');
  assert.equal(call.headers.get('Content-Type'), 'application/json');
  const preferences = new Set(call.headers.get('Prefer').split(',').map((part) => part.trim()));
  assert.ok(preferences.has('resolution=merge-duplicates'));
  assert.ok(preferences.has('missing=default'));
  assert.ok(Array.isArray(call.body));
  assert.equal(call.body.length, 1);
  assert.equal(call.body[0].user_id, ACTOR);
  assert.deepEqual(call.body[0].skills_offered, payload.skills_offered);
  assert.equal('skills_needed' in call.body[0], false);
  assert.equal('location_lat' in call.body[0], false);
  assert.ok(Date.parse(call.body[0].updated_at) >= started);
  assert.ok(Date.parse(call.body[0].updated_at) <= Date.now());
  assert.equal(payload.user_id, OTHER);
  assert.equal(payload.updated_at, 'untrusted-time');
});

test('provider errors parsed by the SDK reject profile reads, writes and RPC calls', async () => {
  const read = fixture(() => providerError());
  await assert.rejects(read.ports.getProfile(ACTOR), { message: 'profile_read_failed' });
  assert.equal(read.calls[0].url.pathname, '/rest/v1/entraide_profils');
  assert.equal(read.calls[0].method, 'GET');
  const write = fixture(() => providerError());
  await assert.rejects(write.ports.saveProfile(ACTOR, { skills_offered: [] }), { message: 'profile_write_failed' });
  assert.equal(write.calls[0].url.pathname, '/rest/v1/entraide_profils');
  assert.equal(write.calls[0].method, 'POST');
  const rpc = fixture(() => providerError(500));
  await assert.rejects(rpc.ports.command('contact', ACTOR, 'list', {}), { message: 'command_failed' });
  assert.equal(rpc.calls[0].url.pathname, '/rest/v1/rpc/entraide_contact_command');
  assert.equal(rpc.calls[0].method, 'POST');
});

test('real RPC serializes the server-selected actor separately from the contact payload', async () => {
  const request = {
    id: REQUEST_ID, requester_id: ACTOR, recipient_id: OTHER, message: 'Bonjour',
    status: 'pending', created_at: STAMP, responded_at: null,
  };
  const { calls, ports } = fixture(() => jsonResponse({ request }));
  const payload = { id: REQUEST_ID, recipient_id: OTHER, message: 'Bonjour' };
  assert.deepEqual(await ports.command('contact', ACTOR, 'send', payload), { request });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url.pathname, '/rest/v1/rpc/entraide_contact_command');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.get('Content-Profile'), 'purama_ai');
  assert.equal(call.headers.get('Authorization'), `Bearer ${SERVICE_KEY}`);
  assert.deepEqual(call.body, { p_actor: ACTOR, p_action: 'send', p_payload: payload });
});

test('auth.getUser reaches the provider with the caller header and distinguishes rejection from outage', async () => {
  const header = 'Bearer synthetic-caller-token';
  const success = fixture(() => jsonResponse(USER));
  assert.deepEqual(await success.ports.authenticate(header), { id: ACTOR });
  assert.equal(success.calls.length, 1);
  assert.equal(success.calls[0].url.pathname, '/auth/v1/user');
  assert.equal(success.calls[0].method, 'GET');
  assert.equal(success.calls[0].headers.get('Authorization'), header);
  assert.equal(success.calls[0].headers.get('apikey'), ANON_KEY);
  const denied = fixture(() => jsonResponse({ code: 'bad_jwt', msg: 'synthetic invalid token' }, 401));
  assert.equal(await denied.ports.authenticate(header), null);
  assert.equal(denied.calls[0].url.pathname, '/auth/v1/user');
  for (const status of [429, 503]) {
    const outage = fixture(() => jsonResponse({ code: 'provider_unavailable', msg: 'synthetic outage' }, status));
    await assert.rejects(outage.ports.authenticate(header), { message: 'auth_unavailable' });
    assert.equal(outage.calls[0].url.pathname, '/auth/v1/user');
  }
});

test('handler plus real SDK derive p_actor from getUser, ignoring unverified token claims and rejecting body authority', async () => {
  const token = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: OTHER })).toString('base64url')}.synthetic-signature`;
  const { calls, ports } = fixture((call) => call.url.pathname === '/auth/v1/user'
    ? jsonResponse(USER) : jsonResponse({ requests: [], blocked_user_ids: [] }));
  const handler = createEntraideHandler('entraide-contact', ports);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const listed = await handler(new Request(`${ORIGIN}/functions/v1/entraide-contact`, { headers }));
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { requests: [], blocked_user_ids: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/auth/v1/user');
  assert.equal(calls[0].headers.get('Authorization'), `Bearer ${token}`);
  assert.deepEqual(calls[1].body, { p_actor: ACTOR, p_action: 'list', p_payload: {} });
  for (const authority of ['p_actor', 'requester_id', 'user_id']) {
    const refused = await handler(new Request(`${ORIGIN}/functions/v1/entraide-contact`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: REQUEST_ID, recipient_id: OTHER, [authority]: OTHER }),
    }));
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'invalid_payload' });
  }
  assert.equal(calls.filter((call) => call.url.pathname.startsWith('/rest/v1/rpc/')).length, 1);
});

test('handler plus real SDK turn a PostgREST failure into a generic 503 without exposing provider detail', async () => {
  const { calls, ports } = fixture((call) => call.url.pathname === '/auth/v1/user'
    ? jsonResponse(USER) : providerError(500));
  const response = await createEntraideHandler('entraide-contact', ports)(new Request(
    `${ORIGIN}/functions/v1/entraide-contact`, { headers: { Authorization: 'Bearer synthetic-token' } },
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  assert.deepEqual(calls.map((call) => call.url.pathname), ['/auth/v1/user', '/rest/v1/rpc/entraide_contact_command']);
});
