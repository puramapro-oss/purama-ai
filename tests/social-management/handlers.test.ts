import assert from 'node:assert/strict';
import {
  defaultSocialConfig, handleSocialAccountsRequest, handleSocialConfigRequest,
  SocialConfigurationConflict,
  type AccountDeps, type ConfigDeps, type ManagedSocialAccount,
} from '../../supabase/functions/_shared/social-management-core.ts';
import { createAccountStore, createConfigStore } from '../../supabase/functions/_shared/social-management-store.ts';

const userId = 'fixture-owner';
const platforms = ['instagram', 'linkedin', 'twitter'];
function request(method: string, body?: unknown, authorization: string | null = 'Bearer fixture-token') {
  return new Request('https://fixture.invalid/social?platform=instagram', {
    method, headers: authorization ? { Authorization: authorization } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function accountFixture() {
  const events: string[] = [];
  const account: ManagedSocialAccount = { id: 'row-1', user_id: userId, platform: 'instagram',
    zernio_account_id: 'account-1', zernio_profile_id: 'profile-1',
    publishing_verified_at: '2026-11-10T00:00:00Z', is_active: true, disconnect_pending: false };
  const deps: AccountDeps = {
    corsHeaders: {}, platforms,
    authenticate: token => { events.push('auth'); return Promise.resolve(token === 'fixture-token' ? { id: userId } : null); },
    store: {
      list: id => { assert.equal(id, userId); events.push('list'); return Promise.resolve([account]); },
      find: (id, platform) => { assert.equal(id, userId); assert.equal(platform, 'instagram'); events.push('find'); return Promise.resolve(account); },
      binding: id => { assert.equal(id, userId); events.push('binding'); return Promise.resolve({ user_id: userId, creation_status: 'ready', zernio_profile_id: 'profile-1' }); },
      deactivate: row => { assert.equal(row, account); events.push('deactivate'); account.is_active = false; return Promise.resolve(true); },
      allowDisconnectReconciliation: row => { assert.equal(row, account); events.push('reconcile-ready'); return Promise.resolve(true); },
      finishDisconnect: row => { assert.equal(row, account); events.push('finish'); return Promise.resolve(true); },
    },
    verifyAccount: value => { assert.deepEqual(value, { profileId: 'profile-1', accountId: 'account-1', platform: 'instagram' }); events.push('verify'); return Promise.resolve({}); },
    confirmAccountAbsent: value => { assert.deepEqual(value, { profileId: 'profile-1', accountId: 'account-1' }); events.push('confirm-absence'); return Promise.resolve(false); },
    disconnectAccount: id => { assert.equal(id, 'account-1'); events.push('disconnect-account'); return Promise.resolve(); },
  };
  return { deps, account, events };
}
function configFixture() {
  const writes: unknown[] = [];
  const config = defaultSocialConfig(userId);
  const deps: ConfigDeps = {
    corsHeaders: {}, platforms,
    authenticate: token => Promise.resolve(token === 'fixture-token' ? { id: userId } : null),
    store: {
      read: id => { assert.equal(id, userId); return Promise.resolve(config); },
      write: value => { writes.push(value); return Promise.resolve(value); },
      verifiedPlatforms: id => { assert.equal(id, userId); return Promise.resolve(['instagram']); },
    },
  };
  return { deps, config, writes };
}

for (const method of ['GET', 'DELETE']) {
  Deno.test(`accounts: ${method} without authentication has no side effects`, async () => {
    const { deps, events } = accountFixture();
    const response = await handleSocialAccountsRequest(request(method, undefined, null), deps);
    assert.equal(response.status, 401); assert.deepEqual(events, []);
  });
}
Deno.test('accounts: only authenticated owner is used for listing', async () => {
  const { deps, events } = accountFixture();
  const response = await handleSocialAccountsRequest(request('GET'), deps);
  assert.equal(response.status, 200); assert.equal((await response.json())[0].user_id, userId);
  assert.deepEqual(events, ['auth', 'list']);
});
Deno.test('accounts: verified disconnect stops local posting first and targets one account', async () => {
  const { deps, events, account } = accountFixture();
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).provider_disconnected, true);
  assert.equal(account.is_active, false);
  assert.deepEqual(events, ['auth', 'find', 'deactivate', 'binding', 'verify', 'disconnect-account', 'finish']);
});
Deno.test('accounts: legacy unverified binding never calls the provider', async () => {
  const { deps, account, events } = accountFixture(); account.publishing_verified_at = null;
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 202); const body = await response.json();
  assert.equal(body.success, false); assert.equal(body.requires_provider_disconnect, true);
  assert.equal(account.is_active, false); assert.deepEqual(events, ['auth', 'find', 'deactivate', 'finish']);
});
Deno.test('accounts: changed binding cannot disconnect a newly reconnected account', async () => {
  const { deps, events } = accountFixture(); deps.store.deactivate = () => Promise.resolve(false);
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 409); assert.deepEqual(events, ['auth', 'find']);
});
Deno.test('accounts: failed local write prevents any provider operation', async () => {
  const { deps, events } = accountFixture(); deps.store.deactivate = () => Promise.reject(new Error('db down'));
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 503); assert.deepEqual(events, ['auth', 'find']);
});
Deno.test('accounts: another profile is never disconnected with the shared key', async () => {
  const { deps, events } = accountFixture();
  deps.store.binding = () => Promise.resolve({ user_id: userId, creation_status: 'ready', zernio_profile_id: 'another-profile' });
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 202); assert.equal((await response.json()).provider_disconnected, false);
  assert.deepEqual(events, ['auth', 'find', 'deactivate', 'finish']);
});
for (const step of ['verifyAccount', 'disconnectAccount'] as const) {
  Deno.test(`accounts: ${step} timeout keeps local posting disabled without false success`, async () => {
    const { deps, account, events } = accountFixture();
    deps[step] = () => Promise.reject(new Error('response lost'));
    const response = await handleSocialAccountsRequest(request('DELETE'), deps);
    assert.equal(response.status, 202); const body = await response.json();
    assert.equal(body.success, false); assert.equal(account.is_active, false);
    assert.equal(events.filter(e => e === 'disconnect-account').length, 0);
  });
}
Deno.test('accounts: SQL error is not confused with an absent account', async () => {
  const { deps, events } = accountFixture(); deps.store.find = () => Promise.reject(new Error('db down'));
  assert.equal((await handleSocialAccountsRequest(request('DELETE'), deps)).status, 503);
  assert.deepEqual(events, ['auth']);
});
Deno.test('accounts: unsupported method does not authenticate or mutate', async () => {
  const { deps, events } = accountFixture();
  assert.equal((await handleSocialAccountsRequest(request('POST', {}), deps)).status, 405);
  assert.deepEqual(events, []);
});
Deno.test('config: missing authentication cannot read configuration', async () => {
  const { deps } = configFixture(); deps.store.read = () => { throw new Error('unexpected read'); };
  assert.equal((await handleSocialConfigRequest(request('GET', undefined, null), deps)).status, 401);
});
Deno.test('config: legacy AI flags cannot advertise an implicit generation', async () => {
  const { deps, config } = configFixture(); config.auto_caption = true; config.auto_hashtags = true;
  const response = await handleSocialConfigRequest(request('GET'), deps);
  const body = await response.json();
  assert.equal(body.auto_caption, false); assert.equal(body.auto_hashtags, false);
});
for (const [label, body, status] of [
  ['other user', { user_id: 'victim' }, 400],
  ['unknown key', { id: 'victim-row' }, 400],
  ['string boolean', { autopilot_enabled: 'true' }, 400],
  ['unknown platform', { default_platforms: ['invented'] }, 400],
  ['invalid timezone', { timezone: 'Not/A/Timezone' }, 400],
  ['implicit caption', { auto_caption: true }, 422],
  ['implicit hashtags', { auto_hashtags: true }, 422],
] as const) {
  Deno.test(`config: rejects ${label} without writing`, async () => {
    const { deps, writes } = configFixture();
    assert.equal((await handleSocialConfigRequest(request('POST', body), deps)).status, status);
    assert.deepEqual(writes, []);
  });
}
Deno.test('config: no verified target means no autopilot activation', async () => {
  const { deps, writes } = configFixture();
  assert.equal((await handleSocialConfigRequest(request('POST', { autopilot_enabled: true, default_platforms: ['linkedin'] }), deps)).status, 409);
  assert.deepEqual(writes, []);
});
Deno.test('config: unfunded X cannot be enabled automatically', async () => {
  const { deps, writes } = configFixture(); deps.store.verifiedPlatforms = () => Promise.resolve(['twitter']);
  assert.equal((await handleSocialConfigRequest(request('POST', { autopilot_enabled: true, default_platforms: ['twitter'] }), deps)).status, 409);
  assert.deepEqual(writes, []);
});
Deno.test('config: verified selection activates once under the authenticated user', async () => {
  const { deps, writes } = configFixture();
  const response = await handleSocialConfigRequest(request('POST', {
    autopilot_enabled: true, default_platforms: ['instagram', 'instagram'], timezone: 'Europe/Paris',
  }), deps);
  assert.equal(response.status, 200); assert.equal(writes.length, 1);
  const body = await response.json();
  assert.equal(body.user_id, userId); assert.equal(body.autopilot_enabled, true);
  assert.deepEqual(body.default_platforms, ['instagram']); assert.equal(body.auto_caption, false);
});
for (const step of ['read', 'write'] as const) {
  Deno.test(`config: database ${step} error is not a success or default fallback`, async () => {
    const { deps } = configFixture(); deps.store[step] = () => Promise.reject(new Error('sql down'));
    assert.equal((await handleSocialConfigRequest(request('POST', { autopilot_enabled: false }), deps)).status, 503);
  });
}
Deno.test('account store: conditional write includes tenant and provider binding snapshot', async () => {
  const { account } = accountFixture();
  const predicates: unknown[][] = [];
  const query = {
    update: (value: unknown) => { assert.deepEqual(value, { is_active: false, disconnect_pending: true, disconnect_reconcile_ready: false }); return query; },
    eq: (...args: unknown[]) => { predicates.push(args); return query; },
    is: (...args: unknown[]) => { predicates.push(args); return query; },
    select: (_columns: string) => Promise.resolve({ data: [{ id: account.id }], error: null }),
  };
  const store = createAccountStore({ from: table => { assert.equal(table, 'social_accounts'); return query; } });
  assert.equal(await store.deactivate(account), true);
  assert.deepEqual(predicates, [
    ['id', account.id], ['user_id', userId], ['platform', account.platform],
    ['zernio_account_id', 'account-1'], ['zernio_profile_id', 'profile-1'],
    ['disconnect_pending', false],
    ['publishing_verified_at', account.publishing_verified_at],
  ]);
});
Deno.test('account store: zero affected rows is a concurrency conflict', async () => {
  const { account } = accountFixture();
  const query = { update: () => query, eq: () => query, is: () => query,
    select: () => Promise.resolve({ data: [], error: null }) };
  assert.equal(await createAccountStore({ from: () => query }).deactivate(account), false);
});
Deno.test('accounts: uncertain DELETE holds the reconnect lock', async () => {
  const { deps, events } = accountFixture();
  deps.disconnectAccount = () => Promise.reject(new Error('response lost'));
  assert.equal((await handleSocialAccountsRequest(request('DELETE'), deps)).status, 202);
  assert.equal(events.includes('finish'), false);
});
Deno.test('accounts: retry GET failure cannot release a previous uncertain DELETE', async () => {
  const { deps, events, account } = accountFixture();
  account.disconnect_pending = true; account.disconnect_reconcile_ready = true; account.is_active = false;
  deps.confirmAccountAbsent = () => Promise.reject(new Error('provider offline'));
  assert.equal((await handleSocialAccountsRequest(request('DELETE'), deps)).status, 202);
  assert.equal(events.includes('finish'), false);
});
Deno.test('accounts: provider confirmation is preserved if final database write fails', async () => {
  const { deps } = accountFixture(); deps.store.finishDisconnect = () => Promise.reject(new Error('db down'));
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  const body = await response.json();
  assert.equal(response.status, 202); assert.equal(body.success, false);
  assert.equal(body.provider_disconnected, true); assert.equal(body.requires_reconciliation, true);
});

Deno.test('accounts: a second request never repeats an uncertain provider DELETE', async () => {
  const { deps, events, account } = accountFixture();
  account.disconnect_pending = true; account.disconnect_reconcile_ready = true; account.is_active = false;
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 202);
  assert.deepEqual(events, ['auth', 'find', 'binding', 'confirm-absence']);
});
Deno.test('accounts: a live disconnect owner cannot be unlocked by a reader', async () => {
  const { deps, events, account } = accountFixture();
  account.disconnect_pending = true; account.disconnect_reconcile_ready = false; account.is_active = false;
  deps.confirmAccountAbsent = () => Promise.resolve(true);
  assert.equal((await handleSocialAccountsRequest(request('DELETE'), deps)).status, 202);
  assert.deepEqual(events, ['auth', 'find']);
});
Deno.test('accounts: complete provider absence resolves a finished uncertain request with GET only', async () => {
  const { deps, events, account } = accountFixture();
  account.disconnect_pending = true; account.disconnect_reconcile_ready = true; account.is_active = false;
  deps.confirmAccountAbsent = () => { events.push('confirm-absence'); return Promise.resolve(true); };
  const response = await handleSocialAccountsRequest(request('DELETE'), deps);
  assert.equal(response.status, 200); assert.equal((await response.json()).provider_disconnected, true);
  assert.deepEqual(events, ['auth', 'find', 'binding', 'confirm-absence', 'finish']);
});
Deno.test('accounts: incomplete provider listing cannot unlock a disconnect', async () => {
  const { deps, events, account } = accountFixture();
  account.disconnect_pending = true; account.disconnect_reconcile_ready = true; account.is_active = false;
  deps.confirmAccountAbsent = () => Promise.reject(new Error('truncated listing'));
  assert.equal((await handleSocialAccountsRequest(request('DELETE'), deps)).status, 202);
  assert.equal(events.includes('finish'), false); assert.equal(events.includes('disconnect-account'), false);
});
Deno.test('account store: an already pending snapshot cannot claim another provider DELETE', async () => {
  const { account } = accountFixture(); account.disconnect_pending = true;
  const predicates: unknown[][] = [];
  const query = { update: () => query, eq: (...args: unknown[]) => { predicates.push(args); return query; }, is: () => query,
    select: () => Promise.resolve({ data: [], error: null }) };
  assert.equal(await createAccountStore({ from: () => query }).deactivate(account), false);
  assert.ok(predicates.some(value => value[0] === 'disconnect_pending' && value[1] === false));
});
Deno.test('config: concurrency conflicts are explicit and never reported as saved', async () => {
  const { deps } = configFixture();
  deps.store.write = () => Promise.reject(new SocialConfigurationConflict('changed'));
  assert.equal((await handleSocialConfigRequest(request('PUT', { timezone: 'UTC' }), deps)).status, 409);
});
Deno.test('config: the original database version accompanies the validated write', async () => {
  const { deps, config } = configFixture(); config.updated_at = '2026-11-10T01:02:03.123456Z';
  deps.store.write = (value, previous) => { assert.equal(previous, config); assert.equal(previous.updated_at, config.updated_at); return Promise.resolve(value); };
  assert.equal((await handleSocialConfigRequest(request('PUT', { timezone: 'UTC' }), deps)).status, 200);
});
Deno.test('config store: compare-and-swap uses owner and database timestamp without replacing it', async () => {
  const config = { ...defaultSocialConfig(userId), updated_at: '2026-11-10T01:02:03.123456Z' };
  const predicates: unknown[][] = [];
  const query = {
    update: (value: Record<string, unknown>) => { assert.equal('updated_at' in value, false); return query; },
    eq: (...args: unknown[]) => { predicates.push(args); return query; },
    select: () => query,
    maybeSingle: () => Promise.resolve({ data: config, error: null }),
  };
  assert.deepEqual(await createConfigStore({ from: () => query }).write(config, config), config);
  assert.deepEqual(predicates, [['user_id', userId], ['updated_at', config.updated_at]]);
});
Deno.test('config store: zero affected rows refuses a stale overwrite', async () => {
  const config = defaultSocialConfig(userId);
  const query = { update: () => query, eq: () => query, is: () => query, select: () => query,
    maybeSingle: () => Promise.resolve({ data: null, error: null }) };
  await assert.rejects(() => createConfigStore({ from: () => query }).write(config, config), SocialConfigurationConflict);
});
Deno.test('config store: concurrent first insert is a conflict without an upsert overwrite', async () => {
  const config = defaultSocialConfig(userId);
  const query = { insert: () => query, select: () => query,
    maybeSingle: () => Promise.resolve({ data: null, error: { code: '23505' } }) };
  await assert.rejects(() => createConfigStore({ from: () => query }).write(config, null), SocialConfigurationConflict);
});
