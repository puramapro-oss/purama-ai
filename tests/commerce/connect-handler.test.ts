import assert from 'node:assert/strict';
import { getHandler } from './serve-capture.ts';
import { fixture, resetConnectFixture, seedConfirmedConnectAccount, syntheticCreationPolicy } from './connect-provider-fixture.ts';
import { createConnectAccountHandler } from '../../supabase/functions/connect-account-session/index.ts';

// Creation/recovery cases qualify the offline protocol with an explicit
// synthetic policy. The separately captured served handler remains closed.
const handler = createConnectAccountHandler(syntheticCreationPolicy);
const servedHandler = getHandler();
const request = (body: unknown = { components: ['payouts', 'balances'] }, bearer: string | null = 'Bearer fixture-user-token') =>
  new Request('https://fixture.invalid/connect-account-session', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer === null ? {} : { authorization: bearer }) },
    body: JSON.stringify(body),
  });
const noProviderEffects = () => {
  assert.equal(fixture.createdAccounts.length, 0); assert.equal(fixture.sessions.length, 0);
  assert.equal(fixture.inserts.length, 0);
};

Deno.test('connect: missing or invalid session cannot access a mapping or a provider', async () => {
  for (const auth of ['missing', 'rejected', 'no-user']) {
    resetConnectFixture();
    if (auth === 'rejected') fixture.authError = { message: 'private-auth-detail' };
    if (auth === 'no-user') fixture.user = null;
    const response = await handler(request(undefined, auth === 'missing' ? null : undefined));
    assert.equal(response.status, 401); noProviderEffects(); assert.equal(fixture.lookupUsers.length, 0);
  }
});

Deno.test('connect: existing owned account opens its session without recreating a mapping', async () => {
  resetConnectFixture();
  await seedConfirmedConnectAccount();
  const response = await servedHandler(request()); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.account_id, 'acct_existing');
  assert.deepEqual(fixture.lookupUsers, ['fixture-user-a']);
  assert.equal(fixture.createdAccounts.length, 0); assert.equal(fixture.inserts.length, 0);
  assert.deepEqual(fixture.sessions, [{ account: 'acct_existing', components: { payouts: { enabled: true }, balances: { enabled: true } } }]);
});

Deno.test('connect: new account receives a session only after its owned mapping is confirmed', async () => {
  resetConnectFixture();
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.account_id, 'acct_fixture_created');
  assert.deepEqual(fixture.events, ['lookup', 'create-account', 'insert', 'create-session']);
  assert.equal(fixture.inserts[0].user_id, 'fixture-user-a');
  assert.equal(fixture.inserts[0].stripe_account_id, body.account_id);
});

Deno.test('connect: lookup failure stops before account creation, insertion or session creation', async () => {
  resetConnectFixture(); fixture.lookup.error = { message: 'private-sql-detail' };
  const response = await handler(request());
  assert.equal(response.status, 503); noProviderEffects();
  assert.equal((await response.text()).includes('private-sql-detail'), false);
});

Deno.test('connect: failed insertion never returns a session or a successful response', async () => {
  resetConnectFixture(); fixture.insertion = { data: null, error: { message: 'private-sql-detail' } };
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 503); assert.equal(fixture.createdAccounts.length, 1);
  assert.equal(fixture.inserts.length, 1); assert.equal(fixture.sessions.length, 0);
  assert.equal(body.client_secret, undefined); assert.equal(body.account_id, undefined);
  assert.equal(JSON.stringify(body).includes('private-sql-detail'), false);
});

Deno.test('connect: a missing or mismatched insertion receipt cannot open a session', async () => {
  for (const data of [null,
    { user_id: 'another-user', stripe_account_id: 'acct_fixture_created' },
    { user_id: 'fixture-user-a', stripe_account_id: 'acct_another' },
  ]) {
    resetConnectFixture(); fixture.insertion = { data, error: null };
    const response = await handler(request());
    assert.equal(response.status, 503); assert.equal(fixture.sessions.length, 0);
  }
});

Deno.test('connect: a mapping returned for another user never reaches Stripe', async () => {
  resetConnectFixture(); fixture.lookup.data = { user_id: 'another-user', stripe_account_id: 'acct_another' };
  const response = await handler(request());
  assert.equal(response.status, 503); noProviderEffects();
});

Deno.test('connect: an empty account binding cannot be treated as an absent mapping', async () => {
  for (const stripe_account_id of ['', '   ']) {
    resetConnectFixture(); fixture.lookup.data = { user_id: 'fixture-user-a', stripe_account_id };
    const response = await handler(request());
    assert.equal(response.status, 503); noProviderEffects();
  }
});

Deno.test('connect: body-supplied user and account identifiers cannot change the authenticated mapping', async () => {
  resetConnectFixture(); await seedConfirmedConnectAccount();
  const response = await servedHandler(request({ user_id: 'another-user', account_id: 'acct_another', components: ['balances'] }));
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.lookupUsers, ['fixture-user-a']);
  assert.equal(fixture.sessions[0].account, 'acct_existing');
  assert.equal(fixture.createdAccounts.length, 0);
});

Deno.test('connect served policy: unqualified creation cannot be enabled by request fields', async () => {
  for (const body of [undefined, { components: ['balances'], qualified: true, creation_enabled: true,
    parameters: { type: 'express', country: 'FR' }, provider_context: 'a'.repeat(64) }]) {
    resetConnectFixture();
    const response = await servedHandler(request(body));
    assert.equal(response.status, 503); noProviderEffects();
    assert.equal(fixture.operation, null);
    assert.equal(fixture.claimArguments[0].p_parameters, null);
  }
});

Deno.test('connect served policy: legacy binding has no implicit provenance', async () => {
  resetConnectFixture(); fixture.lookup.data = { user_id: 'fixture-user-a', stripe_account_id: 'acct_legacy' };
  const original = structuredClone(fixture.lookup.data);
  assert.equal((await servedHandler(request())).status, 503); noProviderEffects();
  assert.equal(fixture.operation, null); assert.deepEqual(fixture.lookup.data, original);
});

Deno.test('connect served policy: pending creation stays unchanged and cannot be resumed', async () => {
  resetConnectFixture(); fixture.providerResults.push('accept-response-lost');
  assert.equal((await handler(request())).status, 503);
  const original = structuredClone(fixture.operation);
  fixture.now += 60_001;
  assert.equal((await servedHandler(request())).status, 503);
  assert.deepEqual(fixture.operation, original);
  assert.equal(fixture.createdAccounts.length, 1); assert.equal(fixture.sessions.length, 0);
  assert.equal(fixture.claimArguments.at(-1)!.p_parameters, null);
});

Deno.test('connect served policy: confirmed receipt must carry this operation and provider context', async () => {
  for (const override of [{ operation_id: undefined }, { operation_id: 'another-operation' },
    { api_version: undefined }, { api_version: 'different-api' }, { provider_context: undefined },
    { provider_context: 'b'.repeat(64) }, { user_id: 'another-user' }]) {
    resetConnectFixture(); await seedConfirmedConnectAccount(); fixture.claimOverride = override;
    assert.equal((await servedHandler(request())).status, 503); noProviderEffects();
  }
});

Deno.test('connect served policy: changed credentials block sessions until the context is requalified', async () => {
  resetConnectFixture(); await seedConfirmedConnectAccount();
  const original = structuredClone(fixture.operation);
  Deno.env.set('STRIPE_SECRET_KEY', 'fixture-rotated-key-not-a-credential');
  assert.equal((await servedHandler(request())).status, 503); noProviderEffects();
  assert.deepEqual(fixture.operation, original);
  Deno.env.set('STRIPE_SECRET_KEY', 'fixture-not-a-credential');
  assert.equal((await servedHandler(request())).status, 200);
  assert.equal(fixture.sessions.length, 1); assert.equal(fixture.createdAccounts.length, 0);
});

Deno.test('connect served policy: missing canonical migration fails closed before provider effects', async () => {
  resetConnectFixture(); fixture.claimError = { message: 'function claim_connect_account_provision does not exist' };
  const response = await servedHandler(request());
  assert.equal(response.status, 503); noProviderEffects(); assert.equal(fixture.operation, null);
  assert.equal((await response.text()).includes('does not exist'), false);
});

Deno.test('connect served policy: malformed or foreign AccountSession receipt never returns success', async () => {
  for (const override of [{ account: undefined }, { account: 'acct_another' },
    { client_secret: undefined }, { client_secret: '' }, { client_secret: '   ' },
    { expires_at: undefined }, { expires_at: Math.floor(Date.now() / 1000) - 1 },
    { expires_at: Math.floor(Date.now() / 1000) + 3600.5 }, { expires_at: Number.MAX_SAFE_INTEGER + 1 },
    { expires_at: '2000000000' }]) {
    resetConnectFixture(); await seedConfirmedConnectAccount(); fixture.sessionOverride = override;
    const response = await servedHandler(request());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Compte de paiement temporairement indisponible' });
    assert.equal(fixture.createdAccounts.length, 0); assert.equal(fixture.inserts.length, 0);
  }
});

Deno.test('connect served policy: a validated session secret is returned with caching disabled', async () => {
  resetConnectFixture(); await seedConfirmedConnectAccount();
  const response = await servedHandler(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.account_id, 'acct_existing'); assert.equal(body.client_secret, 'fixture-session-only');
  assert.ok(Number.isSafeInteger(body.expires_at) && body.expires_at > Math.floor(Date.now() / 1000));
});
