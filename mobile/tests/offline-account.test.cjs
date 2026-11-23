const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OWNER, OTHER, TIME, loader, deferred, tick } = require('./helpers/smarana.cjs');

function ledgerFixture() {
  let time = Date.parse(TIME), raw = null;
  const calls = [];
  const storage = {
    async read() { calls.push('read'); return raw; },
    async write(value) { calls.push('write'); raw = value; },
    async remove() { calls.push('remove'); raw = null; },
  };
  const { createOfflineAccountLedger, OFFLINE_ACCOUNT_LEASE_MS } = loader()('lib/offline-account-core.ts');
  const make = () => createOfflineAccountLedger(storage, () => time);
  return { ledger: make(), make, storage, calls, leaseMs: OFFLINE_ACCOUNT_LEASE_MS,
    get raw() { return raw; }, set raw(value) { raw = value; },
    get time() { return time; }, set time(value) { time = value; } };
}

test('a first offline opening never invents an authenticated account', async () => {
  const f = ledgerFixture();
  assert.equal(await f.ledger.read(), null);
  assert.ok(!f.calls.includes('write'));
});

test('only the current verification ticket can issue a bounded grant', async () => {
  const f = ledgerFixture();
  const old = f.ledger.verificationTicket();
  await f.ledger.selectOwner(OTHER);
  await assert.rejects(f.ledger.rememberVerified(OWNER, old), /changé/);
  const grant = await f.ledger.rememberVerified(OTHER, f.ledger.verificationTicket());
  assert.equal(grant.validUntil - grant.verifiedAt, f.leaseMs);
  assert.equal((await f.ledger.read()).ownerId, OTHER);
});

test('same-account verification preserves an explicit no-sync preference', async () => {
  const f = ledgerFixture();
  await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  await f.ledger.setAutoSync(OWNER, false);
  f.time += 1000;
  const grant = await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  assert.equal(grant.autoSync, false);
});

test('an observed wall-clock rollback cannot extend access across a process restart', async () => {
  const f = ledgerFixture();
  const start = f.time;
  await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  f.time += f.leaseMs - 1000;
  assert.ok(await f.ledger.read());
  const restarted = f.make();
  f.time = start + 1000;
  assert.equal(await restarted.read(), null);
  f.time = start + 2000;
  assert.equal(await f.make().read(), null, 'once revoked by rollback it cannot reopen from the old record');
});

test('an expired grant stays invalid after clock rollback and explicit renewal keeps no-sync', async () => {
  const f = ledgerFixture();
  const start = f.time;
  await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  await f.ledger.setAutoSync(OWNER, false);
  f.time += f.leaseMs + 1;
  assert.equal(await f.ledger.read(), null);
  f.time = start + 1000;
  assert.equal(await f.make().read(), null);
  f.time = start + f.leaseMs + 10;
  assert.equal((await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket())).autoSync, false);
});

test('sign-out and same-owner return cannot retain a late verification write', async () => {
  const f = ledgerFixture();
  const entered = deferred(), release = deferred();
  const originalWrite = f.storage.write;
  f.storage.write = async value => { entered.resolve(); await release.promise; await originalWrite(value); };
  const verify = f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  const rejected = assert.rejects(verify, /changé/);
  await entered.promise;
  const clear = f.ledger.clear();
  const select = f.ledger.selectOwner(OWNER);
  release.resolve();
  await Promise.all([rejected, clear, select]);
  assert.equal(await f.ledger.read(), null);
  assert.equal(await f.make().read(), null);
});

test('an aborted verification cannot leave a grant after a delayed protected write', async () => {
  const f = ledgerFixture();
  const entered = deferred(), release = deferred();
  const controller = new AbortController();
  const write = f.storage.write;
  f.storage.write = async value => { entered.resolve(); await release.promise; await write(value); };
  const verifying = f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket(), controller.signal);
  const rejected = assert.rejects(verifying, /annulée/);
  await entered.promise;
  controller.abort();
  release.resolve();
  await rejected;
  assert.equal(await f.make().read(), null);
});

test('a superseded clear runs before a new verified account and never erases it afterwards', async () => {
  const f = ledgerFixture();
  await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  const clearing = f.ledger.clear();
  const selecting = f.ledger.selectOwner(OTHER);
  const verifying = f.ledger.rememberVerified(OTHER, f.ledger.verificationTicket());
  await Promise.all([clearing, selecting, verifying]);
  assert.equal((await f.ledger.read()).ownerId, OTHER);
});

test('account selection fences an already-running protected read before it returns', async () => {
  const f = ledgerFixture();
  await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  const entered = deferred(), release = deferred();
  const read = f.storage.read;
  let first = true;
  f.storage.read = async () => { if (first) { first = false; entered.resolve(); await release.promise; } return read(); };
  const reading = f.ledger.read();
  await entered.promise;
  const switching = f.ledger.selectOwner(OTHER);
  release.resolve();
  assert.equal(await reading, null);
  await switching;
  assert.equal(await f.ledger.read(), null);
});

test('invalid identities, policy values and grant shapes fail closed', async () => {
  const f = ledgerFixture();
  await assert.rejects(f.ledger.rememberVerified('invalid', 0));
  await f.ledger.rememberVerified(OWNER, f.ledger.verificationTicket());
  await assert.rejects(f.ledger.setAutoSync(OWNER, 'yes'));
  f.raw = JSON.stringify({ ownerId: OWNER, verifiedAt: f.time, validUntil: f.time + f.leaseMs + 1, autoSync: true });
  assert.equal(await f.ledger.read(), null);
});

test('native ledger binds the protected grant to the existing SDK cache without initializing auth', async () => {
  const key = 'purama.smarana.offline-account.v1';
  const sdk = 'sb-project-auth-token';
  const time = Date.now();
  const values = new Map([[key, JSON.stringify({ ownerId: OWNER, verifiedAt: time - 1000, validUntil: time - 1000 + 604800000, autoSync: false })],
    [sdk, JSON.stringify({ user: { id: OWNER }, access_token: 'synthetic', refresh_token: 'synthetic', expires_at: 1 })]]);
  const calls = [];
  const secure = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    async getItemAsync(name) { calls.push(['read', name]); return values.get(name) ?? null; },
    async setItemAsync(name, value) { calls.push(['write', name]); values.set(name, value); },
    async deleteItemAsync(name) { calls.push(['remove', name]); values.delete(name); },
  };
  const make = () => loader({ mocks: { 'expo-secure-store': secure }, environment: { EXPO_PUBLIC_SUPABASE_URL: 'https://project.supabase.co' } })('lib/offline-account.native.ts').offlineAccount;
  assert.equal((await make().read()).ownerId, OWNER);
  assert.ok(calls.every(([, name]) => name === key || name === sdk));
  values.set(sdk, JSON.stringify({ user: { id: OTHER }, access_token: 'synthetic', refresh_token: 'synthetic', expires_at: 1 }));
  assert.equal(await make().read(), null);
  values.delete(sdk);
  assert.equal(await make().read(), null);
});

test('web has no silent account grant or plaintext persistence fallback', async () => {
  const { offlineAccount } = loader()('lib/offline-account.ts');
  assert.equal(await offlineAccount.read(), null);
  await assert.rejects(offlineAccount.rememberVerified(OWNER, 0), /installée/);
});
