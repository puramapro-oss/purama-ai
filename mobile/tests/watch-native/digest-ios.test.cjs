// Host guard tests only. Synthetic receipts are never iOS execution evidence.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const host = require('../../scripts/qualify-digest-ios.cjs');
const contract = require('../../lib/iao-digest-qualification-contract.json');

const runId = '11111111-2222-4333-8444-555555555555';
const otherId = '99999999-2222-4333-8444-555555555555';
const commit = 'a'.repeat(40);
function receipt() {
  return { schema: 1, status: 'PASS', runId, commit, platform: 'ios', engine: 'hermes',
    bundleSource: 'embedded', backend: 'native-sha256',
    checks: Object.fromEntries(contract.checks.map(name => [name, true])), elapsedMs: 50,
    completedAt: new Date().toISOString(), errorCode: null };
}
function inventory(devices) { return { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': devices } }; }

test('accepts only the complete observed receipt for the current bundle and campaign', () => {
  const value = receipt();
  assert.equal(host.validateReceipt(value, { runId, commit, notBefore: Date.now() }), value);
});

for (const [name, mutate] of [
  ['failure status even with all true checks', value => { value.status = 'FAIL'; }],
  ['another campaign', value => { value.runId = otherId; }],
  ['another commit', value => { value.commit = 'b'.repeat(40); }],
  ['Android instead of iOS', value => { value.platform = 'android'; }],
  ['unobserved JavaScript engine', value => { value.engine = 'unknown'; }],
  ['a remote bundle', value => { value.bundleSource = 'remote'; }],
  ['a JavaScript digest fallback', value => { value.backend = 'noble-sha256'; }],
  ['an error concealed under PASS', value => { value.errorCode = 'cleanup-failed'; }],
  ['a newer unknown schema', value => { value.schema = 2; }],
  ['an unknown top-level field', value => { value.extra = true; }],
  ['a missing top-level field', value => { delete value.engine; }],
  ['an unknown check', value => { value.checks.extra = true; }],
  ['a missing check', value => { delete value.checks.emptyVector; }],
  ['a truthy non-boolean check', value => { value.checks.emptyVector = 'true'; }],
  ['a negative duration', value => { value.elapsedMs = -1; }],
  ['a non-finite duration', value => { value.elapsedMs = Infinity; }],
  ['a fractional duration', value => { value.elapsedMs = 0.5; }],
  ['an over-budget duration', value => { value.elapsedMs = 120_001; }],
  ['a malformed timestamp', value => { value.completedAt = 'yesterday'; }],
  ['a noncanonical timestamp', value => { value.completedAt = '2026-11-28'; }],
]) test('rejects ' + name, () => {
  const value = receipt(); mutate(value);
  assert.throws(() => host.validateReceipt(value, { runId, commit }));
});

for (const check of contract.checks) test('requires the native check ' + check, () => {
  const value = receipt(); value.checks[check] = false;
  assert.throws(() => host.validateReceipt(value, { runId, commit }), { code: 'native-checks-incomplete' });
});

test('rejects a receipt from before the current execution and a future timestamp', () => {
  for (const shift of [-120_000, 120_000]) {
    const value = receipt(); value.completedAt = new Date(Date.now() + shift).toISOString();
    assert.throws(() => host.validateReceipt(value, { runId, commit, notBefore: Date.now() }), { code: 'receipt-time-outside-run' });
  }
});

test('rejects malformed expected identities before accepting a receipt', () => {
  for (const expected of [{ runId: 'booted', commit }, { runId, commit: 'main' }]) {
    assert.throws(() => host.validateReceipt(receipt(), expected), { code: 'invalid-host-identity' });
  }
});

test('selects an available iOS runtime and a compatible iPhone without downloading a runtime', () => {
  const runtimes = { runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-19-0', version: '19.0', isAvailable: false },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0', version: '11.0', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', version: '18.5', isAvailable: true },
  ] };
  const device = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', productFamily: 'iPhone',
    minRuntimeVersion: host.versionNumber('18.0'), maxRuntimeVersion: 4_294_967_295 };
  const selected = host.selectSimulator(runtimes, { devicetypes: [
    { ...device, identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-Future', minRuntimeVersion: host.versionNumber('20.0') },
    device,
  ] });
  assert.equal(selected.runtime.version, '18.5'); assert.equal(selected.deviceType, device);
});

test('refuses missing, unknown, incompatible and non-iPhone runtimes', () => {
  assert.throws(() => host.selectSimulator({}, {}), { code: 'invalid-simulator-inventory' });
  for (const runtime of [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', version: '18.5', isAvailable: 'true' },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', version: 'unknown', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0', version: '11.0', isAvailable: true },
  ]) assert.throws(() => host.selectSimulator({ runtimes: [runtime] }, { devicetypes: [] }), { code: 'compatible-ios-runtime-missing' });
  assert.equal(host.versionNumber('65536.1'), -1);
  assert.equal(host.versionNumber('18.256'), -1);
  assert.equal(host.versionNumber('18.5.256'), -1);
});

test('cleans only the simulator created by this run and verifies its disappearance', () => {
  const calls = [];
  const run = (label, executable, args) => {
    calls.push({ label, executable, args });
    if (label === 'cleanup-list-before') return JSON.stringify(inventory([{ udid: runId, state: 'Booted' }, { udid: otherId, state: 'Booted' }]));
    if (label === 'cleanup-list-after') return JSON.stringify(inventory([{ udid: otherId, state: 'Booted' }]));
    return '';
  };
  const result = host.cleanupOwnedSimulator(run, runId);
  assert.equal(result.status, 'PASS'); assert.equal(result.absent, true);
  assert.deepEqual(calls.filter(call => ['shutdown', 'delete'].includes(call.args[1])).map(call => call.args),
    [['simctl', 'shutdown', runId], ['simctl', 'delete', runId]]);
  assert.ok(calls.every(call => !call.args.includes('booted') && !call.args.includes('all') && !call.args.includes(otherId)));
});

test('does not shut down an already stopped simulator and never deletes an arbitrary selector', () => {
  const calls = [];
  const run = (label, executable, args) => {
    calls.push(args);
    return JSON.stringify(inventory(label === 'cleanup-list-before' ? [{ udid: runId, state: 'Shutdown' }] : []));
  };
  assert.equal(host.cleanupOwnedSimulator(run, runId).status, 'PASS');
  assert.ok(calls.every(args => !args.includes('shutdown')));
  for (const bad of ['booted', 'all', '../devices', '']) {
    if (bad) assert.throws(() => host.cleanupOwnedSimulator(() => assert.fail('must not execute'), bad));
    else assert.equal(host.cleanupOwnedSimulator(() => assert.fail('must not execute'), bad).status, 'NOT_CREATED');
  }
});

test('retains shutdown and deletion failures while attempting the remaining owned cleanup', () => {
  const calls = [];
  const run = (label) => {
    calls.push(label);
    if (label === 'cleanup-shutdown') throw undefined;
    if (label === 'cleanup-delete') throw new Error('synthetic delete failure');
    return JSON.stringify(inventory([{ udid: runId, state: 'Booted' }]));
  };
  const result = host.cleanupOwnedSimulator(run, runId);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.errors, ['cleanup-shutdown-failed', 'cleanup-delete-failed', 'owned-simulator-still-present']);
  assert.ok(calls.includes('cleanup-list-after'));
});

test('unknown cleanup inventory remains a failure even if targeted deletion then succeeds', () => {
  let deleted = false;
  const result = host.cleanupOwnedSimulator(label => {
    if (label === 'cleanup-list-before') throw new Error('synthetic unavailable inventory');
    if (label === 'cleanup-delete') { deleted = true; return ''; }
    return JSON.stringify(inventory([]));
  }, runId);
  assert.equal(deleted, true); assert.equal(result.status, 'FAIL'); assert.equal(result.absent, true);
});

test('detects ambiguous owned-device identities', () => {
  assert.throws(() => host.findDevice(inventory([{ udid: runId }, { udid: runId.toUpperCase() }]), runId),
    { code: 'ambiguous-owned-simulator' });
});

test('reads bounded regular receipts, hashes their bytes, and refuses links, directories and oversized content', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-ios-digest-host-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'receipt.json');
  const bytes = Buffer.from(JSON.stringify(receipt())); fs.writeFileSync(filename, bytes);
  assert.deepEqual(host.readReceipt(filename).content, bytes);
  assert.equal(host.fileHash(filename), crypto.createHash('sha256').update(bytes).digest('hex'));
  const link = path.join(directory, 'linked.json'); fs.symlinkSync(filename, link);
  assert.throws(() => host.readReceipt(link));
  assert.throws(() => host.readReceipt(directory));
  fs.writeFileSync(filename, Buffer.alloc(65_537)); assert.throws(() => host.readReceipt(filename));
  fs.writeFileSync(filename, ''); assert.throws(() => host.readReceipt(filename));
  fs.writeFileSync(filename, '{'); assert.throws(() => host.readReceipt(filename));
});

test('refuses a container belonging to another simulator', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-ios-container-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owned = path.join(directory, runId, 'data'); fs.mkdirSync(owned, { recursive: true });
  assert.equal(host.assertOwnedContainer(owned, runId), fs.realpathSync(owned));
  assert.throws(() => host.assertOwnedContainer(owned, otherId), { code: 'container-not-owned' });
});

test('retains the primary command failure when the final evidence write also fails', async () => {
  const messages = [];
  const script = path.resolve(__dirname, '../../scripts/qualify-digest-ios.cjs');
  const sandbox = {
    __dirname: path.dirname(script), module: { exports: {} }, performance,
    process: { platform: 'darwin', env: {}, execPath: process.execPath },
    console: { log: value => messages.push(value), error: () => {} },
    require(name) {
      if (name === '../lib/iao-digest-qualification-contract.json') return contract;
      if (name === 'node:fs') return { ...fs, mkdirSync() {}, writeFileSync(filename) {
        if (filename.endsWith('host-receipt.json')) throw undefined;
      } };
      if (name === 'node:child_process') return { spawnSync: () => ({ status: 1, stdout: '', stderr: '' }) };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  await assert.rejects(sandbox.module.exports.main(), { code: 'command-failed-checkout-commit' });
  const summary = JSON.parse(messages.at(-1));
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.errorCode, 'command-failed-checkout-commit');
});
