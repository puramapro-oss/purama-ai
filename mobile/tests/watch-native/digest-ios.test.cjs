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
const compiledSdk = { DTPlatformName: 'iphonesimulator', DTPlatformVersion: '18.5', DTSDKName: 'iphonesimulator18.5' };

// Compact projection of the observed 00c4a1f runner inventory: values are retained,
// unrelated devices omitted. Its selected 26.2 runtime differed from the built SDK.
function simulatorInventory() {
  const iphone16e = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16e', productFamily: 'iPhone',
    minRuntimeVersion: 1_180_416, maxRuntimeVersion: 4_294_967_295 };
  const iphone17 = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', productFamily: 'iPhone',
    minRuntimeVersion: 1_703_936, maxRuntimeVersion: 4_294_967_295 };
  const member = device => ({ identifier: device.identifier, productFamily: device.productFamily });
  return {
    runtimes: { runtimes: [
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', version: '18.5', isAvailable: true,
        supportedDeviceTypes: [member(iphone16e)] },
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6', version: '18.6', isAvailable: true,
        supportedDeviceTypes: [member(iphone16e)] },
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2', version: '26.2', isAvailable: true,
        supportedDeviceTypes: [member(iphone17), member(iphone16e)] },
    ] },
    devices: { devicetypes: [iphone17, iphone16e] },
  };
}

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

test('matches the compiled SDK 18.5 exactly despite available 18.6 and 26.2 runtimes', () => {
  const { runtimes, devices } = simulatorInventory();
  const selected = host.selectSimulator(runtimes, devices, compiledSdk);
  assert.equal(selected.runtime.identifier, 'com.apple.CoreSimulator.SimRuntime.iOS-18-5');
  assert.equal(selected.runtime.version, '18.5');
  assert.equal(selected.deviceType.identifier, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16e');
});

test('refuses missing, unknown, incompatible and non-iPhone runtimes', () => {
  assert.throws(() => host.selectSimulator({}, {}), { code: 'invalid-simulator-inventory' });
  for (const runtime of [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', version: '18.5', isAvailable: 'true' },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', version: 'unknown', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0', version: '11.0', isAvailable: true },
  ]) assert.throws(() => host.selectSimulator({ runtimes: [runtime] }, { devicetypes: [] }, compiledSdk), { code: 'compatible-ios-runtime-missing' });
  assert.equal(host.versionNumber('65536.1'), -1);
  assert.equal(host.versionNumber('18.256'), -1);
  assert.equal(host.versionNumber('18.5.256'), -1);
});

test('refuses missing, malformed or inconsistent compiled SDK metadata', () => {
  const { runtimes, devices } = simulatorInventory();
  for (const sdk of [undefined, {}, { ...compiledSdk, DTPlatformName: 'iphoneos' },
    { ...compiledSdk, DTPlatformVersion: undefined }, { ...compiledSdk, DTPlatformVersion: 18.5 },
    { ...compiledSdk, DTPlatformVersion: 'unknown' }, { ...compiledSdk, DTSDKName: 'iphonesimulator26.2' }]) {
    assert.throws(() => host.selectSimulator(runtimes, devices, sdk), { code: 'invalid-compiled-ios-sdk' });
  }
});

test('does not fall back to another iOS version when the compiled SDK runtime is absent or unavailable', () => {
  for (const missing of [true, false]) {
    const { runtimes, devices } = simulatorInventory();
    if (missing) runtimes.runtimes.shift();
    else runtimes.runtimes[0].isAvailable = false;
    assert.throws(() => host.selectSimulator(runtimes, devices, compiledSdk), { code: 'compatible-ios-runtime-missing' });
  }
});

test('refuses an unlisted device even when its version range would allow the selected runtime', () => {
  for (const supportedDeviceTypes of [undefined, [], [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', productFamily: 'iPhone' }]]) {
    const { runtimes, devices } = simulatorInventory();
    runtimes.runtimes[0].supportedDeviceTypes = supportedDeviceTypes;
    assert.throws(() => host.selectSimulator(runtimes, devices, compiledSdk), { code: 'compatible-ios-runtime-missing' });
  }
});

test('runtime membership does not override device family or version compatibility', () => {
  for (const change of [{ productFamily: 'iPad' }, { minRuntimeVersion: host.versionNumber('19.0') },
    { maxRuntimeVersion: host.versionNumber('18.4') }, { minRuntimeVersion: '18.0' }]) {
    const { runtimes, devices } = simulatorInventory();
    Object.assign(devices.devicetypes[1], change);
    assert.throws(() => host.selectSimulator(runtimes, devices, compiledSdk), { code: 'compatible-ios-runtime-missing' });
  }
});

test('cleans only the simulator created by this run and verifies its disappearance', () => {
  const calls = [];
  const run = (label, executable, args, options) => {
    calls.push({ label, executable, args, options });
    if (label === 'cleanup-list-before') return JSON.stringify(inventory([{ udid: runId, state: 'Booted' }, { udid: otherId, state: 'Booted' }]));
    if (label === 'cleanup-list-after') return JSON.stringify(inventory([{ udid: otherId, state: 'Booted' }]));
    return '';
  };
  const result = host.cleanupOwnedSimulator(run, runId);
  assert.equal(result.status, 'PASS'); assert.equal(result.absent, true);
  assert.deepEqual(calls.filter(call => ['shutdown', 'delete'].includes(call.args[1])).map(call => call.args),
    [['simctl', 'shutdown', runId], ['simctl', 'delete', runId]]);
  assert.ok(calls.every(call => !call.args.includes('booted') && !call.args.includes('all') && !call.args.includes(otherId)));
  assert.ok(calls.every(call => call.options.timeout === 60_000));
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

test('unknown cleanup inventory still shuts down the owned UUID before deletion and remains a failure', () => {
  let deleted = false;
  const calls = [];
  const result = host.cleanupOwnedSimulator((label, executable, args, options) => {
    calls.push({ label, executable, args, options });
    if (label === 'cleanup-list-before') throw new Error('synthetic unavailable inventory');
    if (label === 'cleanup-delete') { deleted = true; return ''; }
    return JSON.stringify(inventory([]));
  }, runId);
  assert.equal(deleted, true); assert.equal(result.status, 'FAIL'); assert.equal(result.absent, true);
  assert.deepEqual(calls.map(call => call.label), ['cleanup-list-before', 'cleanup-shutdown', 'cleanup-delete', 'cleanup-list-after']);
  assert.deepEqual(result.errors, ['cleanup-inventory-failed']);
  assert.deepEqual(calls.filter(call => ['shutdown', 'delete'].includes(call.args[1])).map(call => call.args),
    [['simctl', 'shutdown', runId], ['simctl', 'delete', runId]]);
  assert.ok(calls.every(call => call.options.timeout === 60_000));
});

test('a successful inventory proving absence performs no shutdown or deletion', () => {
  const calls = [];
  const result = host.cleanupOwnedSimulator((label, executable, args) => {
    calls.push({ label, executable, args });
    return JSON.stringify(inventory([{ udid: otherId, state: 'Booted' }]));
  }, runId);
  assert.equal(result.status, 'PASS'); assert.equal(result.absent, true);
  assert.deepEqual(calls.map(call => call.label), ['cleanup-list-before', 'cleanup-list-after']);
});

test('detects ambiguous owned-device identities', () => {
  assert.throws(() => host.findDevice(inventory([{ udid: runId }, { udid: runId.toUpperCase() }]), runId),
    { code: 'ambiguous-owned-simulator' });
});

const launchHelp = 'Usage: simctl launch [--stdout=<path>] [--stderr=<path>] <device> <app bundle identifier>';
const diagnosticDirectory = '/Users/runner/qualification evidence/ios-digest';

test('redirects application output only through options advertised by launch help', () => {
  assert.deepEqual(host.launchOutputArguments(launchHelp, diagnosticDirectory), [
    '--stdout=/Users/runner/qualification evidence/ios-digest/application.stdout.log',
    '--stderr=/Users/runner/qualification evidence/ios-digest/application.stderr.log',
  ]);
});

test('refuses absent, partial or differently named output options and relative diagnostic paths', () => {
  for (const help of [undefined, '', '--stdout=<path>', '--stderr=<path>',
    '--stdout-file=<path> --stderr-file=<path>', '--stdout --stderr']) {
    assert.throws(() => host.launchOutputArguments(help, diagnosticDirectory), { code: 'launch-output-redirection-unavailable' });
  }
  for (const directory of [undefined, '', 'relative/evidence']) {
    assert.throws(() => host.launchOutputArguments(launchHelp, directory), { code: 'invalid-diagnostic-directory' });
  }
});

test('failure diagnostics are bounded and target only the owned simulator and exact application process', () => {
  const calls = [];
  const result = host.captureFailureDiagnostics((label, executable, args, options) => {
    calls.push({ label, executable, args, options });
    return '';
  }, runId, 'PuramaAI', diagnosticDirectory);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(calls.map(call => call.args), [
    ['simctl', 'io', runId, 'screenshot', diagnosticDirectory + '/failure-screenshot.png'],
    ['simctl', 'spawn', runId, 'log', 'show', '--last', '5m', '--style', 'compact', '--info', '--debug', '--predicate', 'process == "PuramaAI"'],
  ]);
  assert.ok(calls.every(call => call.executable === 'xcrun' && call.options.timeout === 15_000));
  assert.equal(calls[0].options.maxBuffer, 65_536);
  assert.equal(calls[1].options.maxBuffer, 1024 * 1024);
  assert.ok(calls.every(call => !call.args.includes('booted') && !call.args.includes('all') && !call.args.includes(otherId)));
});

test('diagnostic errors including undefined do not prevent the next collection attempt', () => {
  const calls = [];
  const result = host.captureFailureDiagnostics(label => {
    calls.push(label);
    if (label === 'failure-screenshot') throw undefined;
    throw new Error('synthetic log failure');
  }, runId, 'PuramaAI', diagnosticDirectory);
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(calls, ['failure-screenshot', 'failure-app-log']);
  assert.deepEqual(result.errors, ['failure-screenshot-unavailable', 'failure-app-log-unavailable']);
});

test('failure diagnostics reject unowned selectors before executing any command', () => {
  for (const udid of [undefined, 'booted', 'all', '../devices']) {
    assert.throws(() => host.captureFailureDiagnostics(() => assert.fail('must not execute'), udid, 'PuramaAI', diagnosticDirectory),
      { code: 'invalid-owned-simulator' });
  }
});

test('an unsafe or missing process name cannot broaden the unified-log predicate', () => {
  for (const executable of [undefined, '', 'PuramaAI" OR TRUEPREDICATE', '*']) {
    const calls = [];
    const result = host.captureFailureDiagnostics(label => { calls.push(label); }, runId, executable, diagnosticDirectory);
    assert.deepEqual(calls, ['failure-screenshot']);
    assert.deepEqual(result.errors, ['failure-log-process-unavailable']);
    assert.equal(result.status, 'FAIL');
  }
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

// Exercise main's real try/finally ordering with an entirely synthetic filesystem
// and process boundary. No simulator, package installation or native code is run.
function diagnosticMainScenario({ help = launchHelp, sourceWriteFails = false, helpOnStderr = false, launchSucceeds = false, runtimeReceipt = receipt() } = {}) {
  const script = path.resolve(__dirname, '../../scripts/qualify-digest-ios.cjs');
  const mobile = path.resolve(path.dirname(script), '..');
  const evidence = path.join(mobile, 'qa/watch-native/ios-digest');
  const calls = [];
  const writes = new Map();
  const handles = new Map();
  const delegate = '#if DEBUG\nRCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")\n#else\nBundle.main.url(forResource: "main", withExtension: "jsbundle")\n#endif\n';
  const bundle = Buffer.concat([Buffer.from('c61fbc03c103191f', 'hex'), Buffer.from('synthetic bytecode')]);
  const container = '/Users/runner/Library/Developer/CoreSimulator/Devices/' + runId + '/data/Containers';
  let deleted = false;
  let launched = false;
  let fd = 10;
  const syntheticFs = {
    ...fs,
    mkdirSync() {},
    realpathSync: filename => filename === evidence ? diagnosticDirectory : filename,
    readFileSync: filename => typeof filename === 'number' ? handles.get(filename).bytes
      : filename.endsWith('app.json')
        ? JSON.stringify({ expo: { ios: { bundleIdentifier: 'dev.purama.purama-ai' }, scheme: 'purama-ai' } }) : delegate,
    writeFileSync(filename, value) {
      if (sourceWriteFails && filename.endsWith('generated-AppDelegate.swift.txt')) throw undefined;
      writes.set(filename, value);
    },
    readdirSync: directory => [{ name: directory.endsWith('/ios') ? 'PuramaAI' : 'PuramaAI.app', isDirectory: () => true }],
    existsSync: filename => filename.endsWith('AppDelegate.swift') || (launched && filename.endsWith(contract.receiptFile)),
    lstatSync: () => ({ isFile: () => true }),
    statSync: () => ({ isFile: () => true, size: bundle.length }),
    openSync(filename) {
      handles.set(++fd, { bytes: filename.endsWith(contract.receiptFile) ? Buffer.from(JSON.stringify(runtimeReceipt))
        : filename.endsWith('main.jsbundle') ? bundle
        : Buffer.from(filename.endsWith('AppDelegate.swift') ? delegate : 'synthetic executable'), position: 0 });
      return fd;
    },
    fstatSync: handle => ({ isFile: () => true, size: handles.get(handle).bytes.length }),
    readSync(handle, target, offset, length, position) {
      const file = handles.get(handle);
      const start = position ?? file.position;
      const count = file.bytes.copy(target, offset, start, Math.min(file.bytes.length, start + length));
      if (position === undefined || position === null) file.position += count;
      return count;
    },
    closeSync: handle => handles.delete(handle),
  };
  const spawnSync = (program, args, options) => {
    calls.push({ program, args, options });
    const ok = stdout => ({ status: 0, stdout, stderr: '' });
    if (program === 'git') return ok(commit);
    if (program === '/usr/bin/plutil') return ok(JSON.stringify({ ...compiledSdk,
      CFBundleIdentifier: 'dev.purama.purama-ai', CFBundleExecutable: 'PuramaAI' }));
    if (program === '/usr/bin/codesign') return ok('');
    if (program === process.execPath) return ok(args[0] === '-e' ? '/Users/runner/source/mobile/entry.js' : '');
    assert.equal(program, 'xcrun');
    if (args[1] === 'help') return args[2] === 'launch' && helpOnStderr
      ? { status: 0, stdout: '', stderr: help }
      : ok(args[2] === 'launch' ? help : 'get_app_container help');
    if (args[1] === 'list') {
      const fixtures = simulatorInventory();
      return ok(JSON.stringify(args[2] === 'runtimes' ? fixtures.runtimes
        : args[2] === 'devicetypes' ? fixtures.devices : inventory(deleted ? [] : [{ udid: runId, state: 'Booted' }])));
    }
    if (args[1] === 'create') return ok(runId);
    if (args[1] === 'get_app_container') return ok(container + (args[4] === 'app' ? '/Bundle/PuramaAI.app' : '/Data/owned'));
    if (args[1] === 'launch') {
      if (!launchSucceeds) return { status: 1, stdout: '', stderr: 'synthetic primary failure' };
      launched = true;
      return ok('dev.purama.purama-ai: 12345');
    }
    if (args[1] === 'openurl') throw new Error('External URL confirmation must not participate in digest qualification');
    if (args[1] === 'io') throw undefined;
    if (args[1] === 'spawn') return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' };
    if (args[1] === 'delete') deleted = true;
    return ok('');
  };
  const sandbox = {
    __dirname: path.dirname(script), module: { exports: {} }, performance, Buffer,
    process: { platform: 'darwin', env: {}, execPath: process.execPath }, console: { log() {}, error() {} },
    require(name) {
      if (name === '../lib/iao-digest-qualification-contract.json') return contract;
      if (name === 'node:fs') return syntheticFs;
      if (name === 'node:crypto') return { ...crypto, randomUUID: () => runId };
      if (name === 'node:child_process') return { spawnSync };
      if (name === 'node:http') return { get: () => ({ on(event, handler) { if (event === 'error') handler({ code: 'ECONNREFUSED' }); } }) };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  return { run: sandbox.module.exports.main, calls, writes, evidence, delegate };
}

test('main preserves the launch-path failure and cleans up after both diagnostic collectors fail', async () => {
  const scenario = diagnosticMainScenario();
  await assert.rejects(scenario.run(), { code: 'command-failed-simulator-launch' });
  const report = JSON.parse(scenario.writes.get(path.join(scenario.evidence, 'host-receipt.json')));
  assert.equal(report.errorCode, 'command-failed-simulator-launch');
  assert.equal(report.failureDiagnostics.status, 'FAIL');
  assert.deepEqual(report.failureDiagnostics.errors, ['failure-screenshot-unavailable', 'failure-app-log-unavailable']);
  assert.equal(report.cleanup.status, 'PASS');
  assert.equal(report.cleanup.absent, true);
  const actions = scenario.calls.filter(call => call.program === 'xcrun').map(call => call.args[1]);
  assert.deepEqual(actions.slice(-6), ['io', 'spawn', 'list', 'shutdown', 'delete', 'list']);
  const launches = scenario.calls.filter(call => call.program === 'xcrun' && call.args[1] === 'launch');
  assert.equal(launches.length, 1);
  assert.deepEqual(Array.from(launches[0].args), ['simctl', 'launch', ...host.launchOutputArguments(launchHelp, diagnosticDirectory), runId, 'dev.purama.purama-ai']);
  const log = scenario.calls.find(call => call.args[1] === 'spawn');
  assert.equal(log.options.timeout, 15_000); assert.equal(log.options.maxBuffer, 1024 * 1024);
  assert.equal(report.appDelegate.sourceTemplatePatternMatched, true);
  assert.equal(Object.hasOwn(report.appDelegate, 'debugFallbackVerified'), false);
  assert.equal(report.appDelegate.sourceArtifactStatus, 'PASS');
  assert.equal(scenario.writes.get(path.join(scenario.evidence, report.appDelegate.sourceArtifact)), scenario.delegate);
});

test('unsupported launch redirection is refused before creating or launching a simulator', async () => {
  const scenario = diagnosticMainScenario({ help: 'Usage: simctl launch <device> <app bundle identifier>' });
  await assert.rejects(scenario.run(), { code: 'launch-output-redirection-unavailable' });
  assert.ok(scenario.calls.every(call => call.program !== 'xcrun' || !['create', 'launch', 'openurl'].includes(call.args[1])));
  const report = JSON.parse(scenario.writes.get(path.join(scenario.evidence, 'host-receipt.json')));
  assert.equal(report.cleanup.status, 'NOT_CREATED');
});

test('main accepts launch help written to stderr by simctl', async () => {
  const scenario = diagnosticMainScenario({ helpOnStderr: true });
  await assert.rejects(scenario.run(), { code: 'command-failed-simulator-launch' });
  const launches = scenario.calls.filter(call => call.program === 'xcrun' && call.args[1] === 'launch');
  assert.equal(launches.length, 1);
  assert.deepEqual(Array.from(launches[0].args), ['simctl', 'launch',
    ...host.launchOutputArguments(launchHelp, diagnosticDirectory), runId, 'dev.purama.purama-ai']);
});

test('an AppDelegate diagnostic write failure does not replace the later primary failure or skip cleanup', async () => {
  const scenario = diagnosticMainScenario({ sourceWriteFails: true });
  await assert.rejects(scenario.run(), { code: 'command-failed-simulator-launch' });
  const report = JSON.parse(scenario.writes.get(path.join(scenario.evidence, 'host-receipt.json')));
  assert.equal(report.appDelegate.sourceArtifactStatus, 'FAIL');
  assert.equal(report.appDelegate.sourceArtifactErrorCode, 'app-delegate-source-write-failed');
  assert.equal(report.errorCode, 'command-failed-simulator-launch');
  assert.equal(report.cleanup.status, 'PASS');
});

test('main reaches its strict receipt after one launch without opening an external URL', async () => {
  const scenario = diagnosticMainScenario({ launchSucceeds: true, helpOnStderr: true });
  const report = await scenario.run();
  assert.equal(report.status, 'PASS');
  assert.equal(report.qualificationPassed, true);
  assert.equal(report.runtime.runId, runId);
  assert.equal(report.runtime.commit, commit);
  assert.equal(report.cleanup.status, 'PASS');
  assert.equal(report.cleanup.absent, true);
  assert.equal(scenario.calls.filter(call => call.program === 'xcrun' && call.args[1] === 'launch').length, 1);
  assert.equal(scenario.calls.filter(call => call.program === 'xcrun' && call.args[1] === 'openurl').length, 0);
  assert.ok(scenario.writes.has(path.join(scenario.evidence, 'runtime-receipt.json')));
});

test('main rejects an incomplete received check and cleans up instead of publishing qualification success', async () => {
  const invalid = receipt();
  invalid.checks.offsetViewVector = false;
  const scenario = diagnosticMainScenario({ launchSucceeds: true, runtimeReceipt: invalid });
  await assert.rejects(scenario.run(), { code: 'native-checks-incomplete' });
  const report = JSON.parse(scenario.writes.get(path.join(scenario.evidence, 'host-receipt.json')));
  assert.equal(report.status, 'FAIL');
  assert.equal(report.errorCode, 'native-checks-incomplete');
  assert.equal(report.qualificationPassed, undefined);
  assert.equal(report.cleanup.status, 'PASS');
  assert.equal(report.cleanup.absent, true);
  assert.equal(scenario.calls.filter(call => call.program === 'xcrun' && call.args[1] === 'launch').length, 1);
  assert.equal(scenario.calls.filter(call => call.program === 'xcrun' && call.args[1] === 'openurl').length, 0);
});
