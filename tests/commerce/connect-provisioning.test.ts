import assert from 'node:assert/strict';
import { fixture, resetConnectFixture, createClient, syntheticCreationPolicy } from './connect-provider-fixture.ts';
import { createConnectAccountHandler } from '../../supabase/functions/connect-account-session/index.ts';

// Explicit offline protocol qualification; the served policy is tested closed
// in connect-handler.test.ts and has no production creation configuration.
const handler = createConnectAccountHandler(syntheticCreationPolicy);
const request = (method = 'POST', payload = '{"components":["balances"]}') =>
  new Request('https://fixture.invalid/connect-account-session', {
    method, headers: { authorization: 'Bearer fixture-user-token', 'content-type': 'application/json' },
    ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : { body: payload }),
  });
const retryAfterLease = () => { fixture.now += 60_001; };

Deno.test('connect provisioning: a failed reservation has no external effects', async () => {
  resetConnectFixture(); fixture.claimError = { message: 'fixture-private-sql-detail' };
  const response = await handler(request());
  assert.equal(response.status, 503); assert.equal(fixture.providerAccounts.length, 0);
  assert.equal(fixture.sessions.length, 0); assert.equal(fixture.inserts.length, 0);
  assert.equal((await response.text()).includes('fixture-private-sql-detail'), false);
});

Deno.test('connect provisioning: concurrent empty reads share one claimed operation', async () => {
  resetConnectFixture(); fixture.lookupBarrier = 2;
  const responses = await Promise.all([handler(request()), handler(request())]);
  // The second claim may see the active lease or the already committed link.
  // Both schedules must preserve one external account and owned sessions.
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 503].includes(response.status)));
  assert.equal(fixture.providerAccounts.length, 1); assert.equal(fixture.createdAccounts.length, 1);
  assert.equal(fixture.sessions.length, responses.filter(response => response.status === 200).length);
  assert.ok(fixture.sessions.every(session => session.account === fixture.providerAccounts[0].id));
  const key = fixture.createOptions[0].idempotencyKey!;
  assert.equal(key, `connect-create:${fixture.operation!.id}`);
  assert.equal(key.includes(fixture.user!.id), false); assert.equal(key.includes(fixture.user!.email), false);
  assert.equal(fixture.stripeOptions[0].maxNetworkRetries, 0);
});

Deno.test('connect provisioning: retry after failed finalization reuses the key and frozen email', async () => {
  resetConnectFixture(); fixture.finalizeResults.push('reject');
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.persisted, null); assert.equal(fixture.providerAccounts.length, 1);
  assert.equal((await handler(request())).status, 503); // active lease, no new provider call
  assert.equal(fixture.createdAccounts.length, 1);
  const originalParameters = structuredClone(fixture.operation!.parameters);
  fixture.user!.email = 'changed@example.invalid'; retryAfterLease();
  assert.equal((await handler(request())).status, 200);
  assert.equal(fixture.providerAccounts.length, 1); assert.equal(fixture.createdAccounts.length, 2);
  assert.deepEqual(fixture.createOptions[0], fixture.createOptions[1]);
  assert.deepEqual(fixture.createdAccounts[1], originalParameters);
  assert.equal(fixture.persisted!.stripe_account_id, fixture.providerAccounts[0].id);
});

Deno.test('connect provisioning: accepted request with lost response is recovered without another account', async () => {
  resetConnectFixture(); fixture.providerResults.push('accept-response-lost');
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.providerAccounts.length, 1); assert.equal(fixture.persisted, null);
  retryAfterLease();
  assert.equal((await handler(request())).status, 200);
  assert.equal(fixture.providerAccounts.length, 1); assert.equal(fixture.createdAccounts.length, 2);
  assert.deepEqual(fixture.createOptions[0], fixture.createOptions[1]);
});

Deno.test('connect provisioning: a committed finalization with lost receipt is read on retry', async () => {
  resetConnectFixture(); fixture.finalizeResults.push('commit-response-lost');
  assert.equal((await handler(request())).status, 503);
  assert.ok(fixture.persisted); assert.equal(fixture.sessions.length, 0);
  assert.equal((await handler(request())).status, 200);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.providerAccounts.length, 1);
});

Deno.test('connect provisioning: AccountSession failure cannot recreate the confirmed account', async () => {
  resetConnectFixture(); fixture.sessionErrors.push(true);
  assert.equal((await handler(request())).status, 503);
  assert.equal((await handler(request())).status, 200);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.providerAccounts.length, 1);
});

Deno.test('connect provisioning: expiration blocks a new creation even after Stripe could prune the key', async () => {
  resetConnectFixture(); fixture.finalizeResults.push('reject');
  assert.equal((await handler(request())).status, 503);
  const operation = fixture.operation!.id;
  fixture.now += 25 * 60 * 60 * 1000;
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.operation!.id, operation);
  assert.equal(fixture.sessions.length, 0);
});

Deno.test('connect provisioning: a changed credential context cannot reuse an unresolved operation', async () => {
  resetConnectFixture(); fixture.finalizeResults.push('reject');
  assert.equal((await handler(request())).status, 503); retryAfterLease();
  Deno.env.set('STRIPE_SECRET_KEY', 'fixture-other-context-not-a-credential');
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.sessions.length, 0);
});

Deno.test('connect provisioning: an expired claim receipt is checked before any provider call', async () => {
  resetConnectFixture();
  fixture.claimOverride = { lease_until: new Date(fixture.now - 1).toISOString() };
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.createdAccounts.length, 0); assert.equal(fixture.sessions.length, 0);
});

Deno.test('connect provisioning: mismatched ownership, API version or key cannot reach Stripe', async () => {
  for (const override of [{ user_id: 'another-user' }, { api_version: 'different-api' }, { idempotency_key: 'unowned-key' }]) {
    resetConnectFixture(); fixture.claimOverride = override;
    assert.equal((await handler(request())).status, 503);
    assert.equal(fixture.createdAccounts.length, 0); assert.equal(fixture.sessions.length, 0);
  }
});

Deno.test('connect provisioning: unverified provider metadata remains blocked on subsequent requests', async () => {
  resetConnectFixture(); fixture.accountMetadataOverride = { purama_connect_operation: 'another-operation' };
  assert.equal((await handler(request())).status, 503); assert.equal(fixture.operation!.state, 'reconcile');
  fixture.accountMetadataOverride = undefined; retryAfterLease();
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.sessions.length, 0);
});

Deno.test('connect provisioning: contradictory receipt quarantines the entire session path despite a binding', async () => {
  resetConnectFixture(); assert.equal((await handler(request())).status, 200);
  const confirmed = fixture.persisted!.stripe_account_id;
  const result = await createClient().rpc('finalize_connect_account_provision', {
    p_user_id: fixture.user!.id, p_operation_id: fixture.operation!.id,
    p_account_id: 'acct_contradictory', p_provider_verified: true,
  });
  assert.equal(result.data!.decision, 'reconcile');
  assert.equal(fixture.persisted!.stripe_account_id, confirmed);
  const sessionsBefore = fixture.sessions.length;
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.sessions.length, sessionsBefore); assert.equal(fixture.createdAccounts.length, 1);
});

Deno.test('connect provisioning: credential rotation preserves the binding but blocks its session', async () => {
  resetConnectFixture(); assert.equal((await handler(request())).status, 200);
  const original = structuredClone(fixture.operation);
  Deno.env.set('STRIPE_SECRET_KEY', 'fixture-rotated-key-not-a-credential');
  assert.equal((await handler(request())).status, 503);
  assert.deepEqual(fixture.operation, original);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.sessions.length, 1);
});

Deno.test('connect provisioning: a missing mapping cannot be replaced by a stale bound receipt', async () => {
  resetConnectFixture(); assert.equal((await handler(request())).status, 200);
  fixture.persisted = null;
  assert.equal((await handler(request())).status, 503);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.sessions.length, 1);
  assert.equal(fixture.operation!.state, 'reconcile');
});

Deno.test('connect provisioning: finalization receipt must confirm this exact operation', async () => {
  resetConnectFixture(); fixture.insertion = { data: {
    user_id: 'fixture-user-a', stripe_account_id: 'acct_fixture_created', operation_id: 'another-operation',
  }, error: null };
  assert.equal((await handler(request())).status, 503); assert.equal(fixture.sessions.length, 0);
});

Deno.test('connect provisioning: exception bodies and logs contain only a generic failure code', async () => {
  resetConnectFixture(); fixture.providerResults.push('throw-before');
  const original = console.error; const messages: unknown[][] = [];
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    const response = await handler(request()); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Compte de paiement temporairement indisponible' });
    assert.deepEqual(messages, [['[connect-account-session] unavailable']]);
  } finally { console.error = original; }
});

Deno.test('connect provisioning: non-POST methods and malformed payloads have no provider effects', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    resetConnectFixture(); const response = await handler(request(method));
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
    assert.equal(fixture.lookupUsers.length, 0); assert.equal(fixture.createdAccounts.length, 0);
  }
  for (const body of ['{broken', 'null', '[]', '{"components":[]}']) {
    resetConnectFixture(); assert.equal((await handler(request('POST', body))).status, 400);
    assert.equal(fixture.createdAccounts.length, 0); assert.equal(fixture.sessions.length, 0);
  }
  resetConnectFixture(); assert.equal((await handler(request('OPTIONS'))).status, 200);
  assert.equal(fixture.createdAccounts.length, 0);
});
