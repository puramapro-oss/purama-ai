import assert from 'node:assert/strict';
import { getHandler } from './serve-capture.ts';
import { fixture, resetConnectFixture } from './connect-provider-fixture.ts';
import '../../supabase/functions/connect-account-session/index.ts';

const handler = getHandler();
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
  fixture.lookup.data = { user_id: 'fixture-user-a', stripe_account_id: 'acct_existing' };
  const response = await handler(request()); const body = await response.json();
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
  resetConnectFixture(); fixture.lookup.data = { user_id: 'fixture-user-a', stripe_account_id: 'acct_existing' };
  const response = await handler(request({ user_id: 'another-user', account_id: 'acct_another', components: ['balances'] }));
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.lookupUsers, ['fixture-user-a']);
  assert.equal(fixture.sessions[0].account, 'acct_existing');
  assert.equal(fixture.createdAccounts.length, 0);
});
