import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthHarness, oauthRequest, OWNER, OTHER, STATE } from './handler-harness.mjs';

test('callback refuses an unverified actor before provider or privileged client', async () => {
  const { handler, calls } = oauthHarness();
  const forged = btoa(JSON.stringify({ userId: OTHER, provider: 'gmail' }));
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: forged }, 'invalid-token', { legacyGet: true }));
  assert.ok([401, 403, 405].includes(response.status), `unsafe response ${response.status}`);
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.clients.filter(x => x.service).length, 0);
  assert.equal(calls.writes.length, 0);
});

test('refresh refuses an unverified actor before reading or refreshing a connection', async () => {
  const { handler, calls } = oauthHarness();
  const response = await handler(oauthRequest('refresh', { provider: 'gmail', userId: OTHER }, 'invalid-token'));
  assert.equal(response.status, 401);
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.clients.filter(x => x.service).length, 0);
});

test('refresh cannot target another account with a valid caller token', async () => {
  const { handler, calls } = oauthHarness();
  const response = await handler(oauthRequest('refresh', { provider: 'gmail', userId: OTHER }));
  assert.ok([400, 403].includes(response.status));
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.writes.length, 0);
});

test('failed connection persistence cannot become successful refresh', async () => {
  const { handler, calls } = oauthHarness({ writeFailure: true });
  const response = await handler(oauthRequest('refresh', { provider: 'gmail', userId: OWNER }));
  assert.ok(response.status >= 500, `false success ${response.status}`);
  assert.equal(calls.writes.length, 1);
  assert.doesNotMatch(await response.text(), /fixture-new-access|private-write-error/);
});

test('authorize requires a verified actor', async () => {
  const { handler, calls } = oauthHarness();
  const response = await handler(oauthRequest('authorize', { provider: 'gmail' }, null, { legacyGet: true }));
  assert.ok([401, 405].includes(response.status));
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.clients.filter(x => x.service).length, 0);
});

test('callback rejects the old self-selected Base64 state', async () => {
  const { handler, calls } = oauthHarness();
  const state = btoa(JSON.stringify({ provider: 'gmail', userId: OWNER, returnUrl: '/mes-connexions' }));
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state }, 'fixture-owner', { legacyGet: true }));
  assert.ok([400, 403, 405, 409].includes(response.status));
  assert.equal(calls.provider.length, 0);
  assert.equal(calls.writes.length, 0);
});

test('success contract is bound to the current server-side state', async () => {
  const { handler, calls } = oauthHarness();
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.provider, 'gmail');
  assert.equal(result.returnUrl, '/mes-connexions');
  assert.equal(calls.auth.length, 2);
  assert.equal(calls.provider.length, 1);
  assert.equal(calls.writes[0].values.user_id, OWNER);
  assert.doesNotMatch(JSON.stringify(result), /fixture-new-access|fixture-new-refresh/);
});

test('authorize stores a digest of an opaque state and chooses scopes on the server', async () => {
  const { handler, calls, states } = oauthHarness({ initialState: false });
  const response = await handler(oauthRequest('authorize', { provider: 'gmail' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.state, /^[0-9a-f]{64}$/);
  assert.equal(Number.isFinite(Date.parse(result.expiresAt)), true);
  const url = new URL(result.authUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('state'), result.state);
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(states.size, 1);
  assert.equal(states.has(result.state), false);
  assert.equal(calls.rpc[0].args.p_user_id, OWNER);
  assert.equal(calls.rpc[0].args.p_purpose, 'google_connections');
  assert.equal(calls.provider.length, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('browser-selected scopes and state cannot replace the server authorization policy', async () => {
  const { handler, calls } = oauthHarness();
  const response = await handler(oauthRequest('authorize', { provider: 'gmail', scopes: 'admin', state: 'chosen' }));
  assert.equal(response.status, 400); assert.equal(calls.rpc.length, 0); assert.equal(calls.provider.length, 0);
});

for (const [name, options] of [
  ['expired', { expiredState: true }], ['already missing', { initialState: false }],
  ['wrong actor', { stateOwner: OTHER }], ['wrong purpose', { statePurpose: 'email_agent_gmail' }],
]) {
  test(`${name} callback state is rejected before Google`, async () => {
    const { handler, calls } = oauthHarness(options);
    const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
    assert.equal(response.status, 409); assert.equal(calls.provider.length, 0); assert.equal(calls.writes.length, 0);
  });
}

test('simultaneous callbacks using one state cannot exchange the code twice', async () => {
  const { handler, calls } = oauthHarness();
  const responses = await Promise.all(Array.from({ length: 8 }, () => handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }))));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 7);
  assert.equal(calls.provider.length, 1); assert.equal(calls.writes.length, 1);
});

test('state storage failure refuses callback admission', async () => {
  const { handler, calls } = oauthHarness({ stateDbFailure: true });
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 503); assert.equal(calls.provider.length, 0); assert.equal(calls.writes.length, 0);
  assert.doesNotMatch(await response.text(), /private-state-error/);
});

test('a state consumed before a failed provider call cannot be replayed', async () => {
  const { handler, calls } = oauthHarness({ providerThrows: true });
  const first = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  const replay = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(first.status, 502); assert.equal(replay.status, 409);
  assert.equal(calls.provider.length, 1); assert.equal(calls.writes.length, 0);
});

for (const [name, tokens] of [
  ['missing access token', { expires_in: 3600, token_type: 'Bearer', refresh_token: 'fixture' }],
  ['blank access token', { access_token: '', expires_in: 3600, token_type: 'Bearer', refresh_token: 'fixture' }],
  ['negative lifetime', { access_token: 'fixture', expires_in: -1, token_type: 'Bearer', refresh_token: 'fixture' }],
  ['unrecognized token type', { access_token: 'fixture', expires_in: 3600, token_type: 'Other', refresh_token: 'fixture' }],
  ['missing offline consent', { access_token: 'fixture', expires_in: 3600, token_type: 'Bearer' }],
]) {
  test(`${name} cannot produce a connected receipt`, async () => {
    const { handler, calls, connections } = oauthHarness({ tokens });
    const previous = structuredClone(connections.get(OWNER));
    const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
    assert.equal(response.status, 502); assert.equal(calls.writes.length, 0); assert.deepEqual(connections.get(OWNER), previous);
  });
}

test('refresh updates only the verified actor and never returns provider credentials', async () => {
  const { handler, calls, connections } = oauthHarness({ tokens: { access_token: 'fixture-refreshed', expires_in: 3600, token_type: 'Bearer' } });
  const foreign = structuredClone(connections.get(OTHER));
  const response = await handler(oauthRequest('refresh', { provider: 'gmail' }));
  assert.equal(response.status, 200); const receipt = await response.json();
  assert.equal(receipt.success, true); assert.equal(receipt.provider, 'gmail');
  assert.doesNotMatch(JSON.stringify(receipt), /fixture-refresh|fixture-refreshed|access_token|refresh_token/);
  assert.equal(calls.writes[0].filters.user_id, OWNER); assert.equal(calls.writes[0].filters.provider, 'gmail');
  assert.equal(connections.get(OWNER).refresh_token, 'fixture-refresh'); assert.deepEqual(connections.get(OTHER), foreign);
});

test('a disappeared connection cannot be reported as refreshed', async () => {
  const { handler } = oauthHarness({ missingUpdate: true });
  const response = await handler(oauthRequest('refresh', { provider: 'gmail' }));
  assert.equal(response.status, 409); assert.doesNotMatch(await response.text(), /fixture-new-access/);
});

test('a pending identity lookup reaches the total deadline before privileged work', async () => {
  const { handler, calls } = oauthHarness({ authPending: true, timerLimit: 25 });
  const response = await handler(oauthRequest('authorize', { provider: 'gmail' }));
  assert.equal(response.status, 504); assert.equal(calls.provider.length, 0); assert.equal(calls.rpc.length, 0);
  assert.equal(calls.clients.filter(x => x.service).length, 0);
});

test('a provider ignoring cancellation still produces a bounded HTTP failure', async () => {
  const { handler, calls } = oauthHarness({ providerPending: true, timerLimit: 25 });
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 504); assert.equal(calls.writes.length, 0);
});

test('a token response with an unbounded body cannot keep the request pending', async () => {
  const { handler, calls } = oauthHarness({ timerLimit: 25, providerResponse: () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) });
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 504); assert.equal(calls.writes.length, 0);
});

test('an oversized token response is refused without persistence', async () => {
  const { handler, calls } = oauthHarness({ providerResponse: () => Response.json({ access_token: 'x'.repeat(70_000) }) });
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 502); assert.equal(calls.writes.length, 0);
});

test('provider redirects are not allowed to carry client credentials elsewhere', async () => {
  const { handler, calls } = oauthHarness();
  await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(calls.provider[0].init.redirect, 'error'); assert.equal(calls.provider[0].init.credentials, 'omit');
});

test('an already cancelled callback makes no identity, storage or provider call', async () => {
  const controller = new AbortController(); controller.abort();
  const { handler, calls } = oauthHarness();
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }, 'fixture-owner', { signal: controller.signal }));
  assert.equal(response.status, 408); assert.equal(calls.auth.length, 0); assert.equal(calls.rpc.length, 0); assert.equal(calls.provider.length, 0);
});

for (const action of ['authorize', 'callback']) {
  test(`POST ${action} requires a verified human actor before any privileged port`, async () => {
    const { handler, calls } = oauthHarness();
    const body = action === 'callback' ? { code: 'synthetic-code', state: STATE } : { provider: 'gmail' };
    const response = await handler(oauthRequest(action, body, 'invalid-token'));
    assert.equal(response.status, 401); assert.equal(calls.auth.length, 1);
    assert.equal(calls.clients.filter(x => x.service).length, 0); assert.equal(calls.rpc.length, 0);
    assert.equal(calls.provider.length, 0); assert.equal(calls.writes.length, 0);
  });
}

test('revocation after provider exchange prevents connection persistence', async () => {
  const { handler, calls } = oauthHarness({ revokeOnRecheck: true });
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 401); assert.equal(calls.provider.length, 1); assert.equal(calls.auth.length, 2);
  assert.equal(calls.writes.length, 0);
});

test('failure after state admission cannot trigger a second provider exchange', async () => {
  const { handler, calls } = oauthHarness({ writeFailure: true });
  const first = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  const replay = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(first.status, 503); assert.equal(replay.status, 409);
  assert.equal(calls.provider.length, 1); assert.equal(calls.writes.length, 1);
});

test('a declared partial scope cannot be persisted as a Gmail connection', async () => {
  const { handler, calls } = oauthHarness({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh',
    expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/userinfo.email' } });
  const response = await handler(oauthRequest('callback', { code: 'synthetic-code', state: STATE }));
  assert.equal(response.status, 403); assert.equal(calls.writes.length, 0);
});

test('scope matching is exact and case-sensitive during refresh', async () => {
  const { handler, calls } = oauthHarness({ tokens: { access_token: 'fixture-access', expires_in: 3600, token_type: 'Bearer',
    scope: 'https://www.googleapis.com/auth/gmail.modify.extra' } });
  const response = await handler(oauthRequest('refresh', { provider: 'gmail' }));
  assert.equal(response.status, 403); assert.equal(calls.writes.length, 0);
});
