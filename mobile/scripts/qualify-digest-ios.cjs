'use strict';

// Qualification of the existing native module in the existing simulator app.
// No model, account, service, signing identity, or production device is opened.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const contract = require('../lib/iao-digest-qualification-contract.json');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const RECEIPT_LIMIT = 65_536;
const RECEIPT_WAIT_MS = 120_000;
const RECEIPT_KEYS = ['schema', 'status', 'runId', 'commit', 'platform', 'engine', 'bundleSource',
  'backend', 'checks', 'elapsedMs', 'completedAt', 'errorCode'];

function requireCondition(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateReceipt(receipt, expected) {
  requireCondition(UUID.test(expected.runId) && SHA.test(expected.commit), 'invalid-host-identity');
  requireCondition(hasExactKeys(receipt, RECEIPT_KEYS), 'invalid-receipt-shape');
  requireCondition(receipt.schema === contract.schema && receipt.status === 'PASS', 'qualification-not-passed');
  requireCondition(receipt.runId === expected.runId && receipt.commit === expected.commit, 'receipt-identity-mismatch');
  requireCondition(receipt.platform === 'ios' && receipt.engine === 'hermes'
    && receipt.bundleSource === 'embedded' && receipt.backend === 'native-sha256', 'runtime-not-qualified');
  requireCondition(hasExactKeys(receipt.checks, contract.checks)
    && contract.checks.every(key => receipt.checks[key] === true), 'native-checks-incomplete');
  requireCondition(receipt.errorCode === null, 'receipt-error-present');
  requireCondition(Number.isSafeInteger(receipt.elapsedMs) && receipt.elapsedMs >= 0
    && receipt.elapsedMs <= RECEIPT_WAIT_MS, 'invalid-receipt-duration');
  const completedAt = typeof receipt.completedAt === 'string' ? Date.parse(receipt.completedAt) : NaN;
  requireCondition(Number.isFinite(completedAt) && new Date(completedAt).toISOString() === receipt.completedAt,
    'invalid-receipt-time');
  if (expected.notBefore !== undefined) {
    requireCondition(completedAt >= expected.notBefore - 60_000 && completedAt <= Date.now() + 60_000,
      'receipt-time-outside-run');
  }
  return receipt;
}

function versionNumber(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(version);
  if (!match) return -1;
  const [major, minor, patch] = match.slice(1).map(part => Number(part || 0));
  return major <= 65_535 && minor <= 255 && patch <= 255 ? major * 65_536 + minor * 256 + patch : -1;
}

function selectSimulator(runtimes, deviceTypes) {
  requireCondition(Array.isArray(runtimes?.runtimes) && Array.isArray(deviceTypes?.devicetypes),
    'invalid-simulator-inventory');
  const available = runtimes.runtimes.filter(item => item.isAvailable === true
    && typeof item.identifier === 'string' && item.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-')
    && versionNumber(item.version) >= 0).sort((a, b) => versionNumber(b.version) - versionNumber(a.version));
  for (const runtime of available) {
    const version = versionNumber(runtime.version);
    const devices = deviceTypes.devicetypes.filter(item => item.productFamily === 'iPhone'
      && typeof item.identifier === 'string' && item.identifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-')
      && Number.isSafeInteger(item.minRuntimeVersion) && item.minRuntimeVersion <= version
      && Number.isSafeInteger(item.maxRuntimeVersion) && item.maxRuntimeVersion >= version)
      .sort((a, b) => b.minRuntimeVersion - a.minRuntimeVersion || a.identifier.localeCompare(b.identifier));
    if (devices.length) return { runtime, deviceType: devices[0] };
  }
  throw Object.assign(new Error('compatible-ios-runtime-missing'), { code: 'compatible-ios-runtime-missing' });
}

function findDevice(inventory, udid) {
  requireCondition(UUID.test(udid) && inventory?.devices !== null && typeof inventory?.devices === 'object'
    && !Array.isArray(inventory.devices), 'invalid-device-inventory');
  const matches = Object.values(inventory.devices).flat().filter(item => item?.udid?.toLowerCase() === udid.toLowerCase());
  requireCondition(matches.length <= 1, 'ambiguous-owned-simulator');
  return matches[0];
}

function cleanupOwnedSimulator(run, udid) {
  if (!udid) return { status: 'NOT_CREATED' };
  requireCondition(UUID.test(udid), 'invalid-owned-simulator');
  const errors = [];
  let device;
  try { device = findDevice(JSON.parse(run('cleanup-list-before', 'xcrun', ['simctl', 'list', 'devices', '--json'])), udid); }
  catch { errors.push('cleanup-inventory-failed'); }
  if (device && device.state !== 'Shutdown') {
    try { run('cleanup-shutdown', 'xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 }); }
    catch { errors.push('cleanup-shutdown-failed'); }
  }
  // Delete only the UUID returned by this run's successful create command.
  if (device || errors.length) {
    try { run('cleanup-delete', 'xcrun', ['simctl', 'delete', udid], { timeout: 30_000 }); }
    catch { errors.push('cleanup-delete-failed'); }
  }
  let absent = false;
  try { absent = !findDevice(JSON.parse(run('cleanup-list-after', 'xcrun', ['simctl', 'list', 'devices', '--json'])), udid); }
  catch { errors.push('cleanup-verification-failed'); }
  if (!absent) errors.push('owned-simulator-still-present');
  return { status: errors.length ? 'FAIL' : 'PASS', udid, absent, errors };
}

function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    requireCondition(fs.fstatSync(fd).isFile(), 'hash-source-not-file');
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function readReceipt(filename) {
  requireCondition(fs.lstatSync(filename).isFile(), 'receipt-not-regular-file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    requireCondition(stat.isFile() && stat.size > 0 && stat.size <= RECEIPT_LIMIT, 'invalid-receipt-file');
    const content = fs.readFileSync(fd);
    requireCondition(content.length === stat.size, 'receipt-changed-during-read');
    return { receipt: JSON.parse(content.toString('utf8')), content };
  } finally { fs.closeSync(fd); }
}

function assertOwnedContainer(container, udid) {
  requireCondition(typeof container === 'string' && path.isAbsolute(container)
    && UUID.test(udid) && fs.realpathSync(container).toLowerCase().includes('/' + udid.toLowerCase() + '/'),
  'container-not-owned');
  return fs.realpathSync(container);
}

async function assertNoMetro() {
  await new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: 8081, path: '/status', timeout: 1500 }, response => {
      response.resume();
      reject(Object.assign(new Error('unexpected-packager-port-listener'), { code: 'unexpected-packager-port-listener' }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('packager-probe-timeout'), { code: 'packager-probe-timeout' })));
    request.on('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
}

async function main() {
  requireCondition(process.platform === 'darwin', 'macos-required');
  const mobile = path.resolve(__dirname, '..');
  const evidence = path.join(mobile, 'qa/watch-native/ios-digest');
  fs.mkdirSync(evidence, { recursive: true });
  const runId = crypto.randomUUID();
  const notBefore = Date.now();
  const report = { schema: 1, status: 'FAIL', runId, startedAt: new Date(notBefore).toISOString(),
    scope: 'Native SHA-256 in Hermes on an iOS simulator; no inference, memory, physical-device or GC qualification.',
    commands: [], cleanup: { status: 'NOT_CREATED' } };
  let udid;
  let failed = false;
  let failure;
  const run = (label, executable, args, options = {}) => {
    requireCondition(/^[a-z0-9-]+$/.test(label), 'invalid-command-label');
    const began = performance.now();
    const result = spawnSync(executable, args, { cwd: mobile, encoding: 'utf8', timeout: options.timeout || 30_000,
      maxBuffer: 16 * 1024 * 1024, env: options.env || process.env, shell: false });
    fs.writeFileSync(path.join(evidence, label + '.stdout.log'), result.stdout || '');
    fs.writeFileSync(path.join(evidence, label + '.stderr.log'), result.stderr || '');
    report.commands.push({ label, executable, args, exit: result.status, signal: result.signal,
      milliseconds: Math.round(performance.now() - began), errorCode: result.error?.code || null });
    requireCondition(!result.error, 'command-error-' + label);
    if (!options.allowFailure) requireCondition(result.status === 0, 'command-failed-' + label);
    return options.result ? result : (result.stdout || '').trim();
  };
  try {
    const commit = run('checkout-commit', 'git', ['rev-parse', 'HEAD']);
    const tree = run('checkout-tree', 'git', ['rev-parse', 'HEAD^{tree}']);
    requireCondition(SHA.test(commit) && SHA.test(tree), 'invalid-checkout-identity');
    report.commit = commit; report.tree = tree;
    const appConfig = JSON.parse(fs.readFileSync(path.join(mobile, 'app.json'), 'utf8')).expo;
    const bundleId = appConfig?.ios?.bundleIdentifier;
    const scheme = appConfig?.scheme;
    requireCondition(typeof bundleId === 'string' && /^[A-Za-z0-9.-]+$/.test(bundleId)
      && typeof scheme === 'string' && /^[a-z][a-z0-9+.-]+$/.test(scheme), 'invalid-app-identity');
    const products = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'purama-watch-ios-derived/Build/Products/Debug-iphonesimulator');
    const apps = [];
    for (const item of fs.readdirSync(products, { withFileTypes: true })) {
      if (!item.isDirectory() || !item.name.endsWith('.app')) continue;
      const app = path.join(products, item.name);
      const info = JSON.parse(run('app-info-' + apps.length, '/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]));
      if (info.CFBundleIdentifier === bundleId) apps.push({ app, info });
    }
    requireCondition(apps.length === 1, 'compiled-app-not-unique');
    const { app, info } = apps[0];
    requireCondition(typeof info.CFBundleExecutable === 'string' && path.basename(info.CFBundleExecutable) === info.CFBundleExecutable,
      'invalid-app-executable');
    report.bundleId = bundleId;
    report.executableSha256 = fileHash(path.join(app, info.CFBundleExecutable));

    const delegates = fs.readdirSync(path.join(mobile, 'ios'), { withFileTypes: true })
      .filter(item => item.isDirectory() && item.name !== 'Pods')
      .map(item => path.join(mobile, 'ios', item.name, 'AppDelegate.swift')).filter(filename => fs.existsSync(filename));
    requireCondition(delegates.length === 1, 'generated-app-delegate-not-unique');
    const delegate = fs.readFileSync(delegates[0], 'utf8');
    requireCondition(delegate.includes('#if DEBUG') && delegate.includes('RCTBundleURLProvider.sharedSettings().jsBundleURL')
      && delegate.includes('.expo/.virtual-metro-entry') && /Bundle\.main\.url\(forResource:\s*"main",\s*withExtension:\s*"jsbundle"\)/.test(delegate),
    'generated-bundle-fallback-unverified');
    report.appDelegate = { path: path.relative(mobile, delegates[0]), sha256: fileHash(delegates[0]), debugFallbackVerified: true };
    const signature = run('signature-before', '/usr/bin/codesign', ['-d', '--verbose=4', app], { allowFailure: true, result: true });
    const wasSigned = signature.status === 0;
    requireCondition(wasSigned || /code object is not signed at all/.test(signature.stderr || ''), 'signature-state-unavailable');
    report.signature = { before: wasSigned ? 'signed' : 'unsigned', adHocResealed: false };

    const exportEnv = { ...process.env, EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1', EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '0',
      EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID: runId, EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT: commit };
    delete exportEnv.EXPO_NO_CLIENT_ENV_VARS;
    const entry = run('resolve-app-entry', process.execPath,
      ['-e', "require('expo/scripts/resolveAppEntry')", mobile, 'ios', 'absolute'], { env: exportEnv });
    requireCondition(path.isAbsolute(entry) && fs.statSync(entry).isFile(), 'invalid-app-entry');
    const bundle = path.join(app, 'main.jsbundle');
    await assertNoMetro();
    run('embed-hermes-bundle', process.execPath, ['node_modules/expo/bin/cli', 'export:embed', '--platform', 'ios',
      '--entry-file', entry, '--bundle-output', bundle, '--assets-dest', app, '--dev', 'false', '--bytecode', '--max-workers', '2'],
    { timeout: 300_000, env: exportEnv });
    const bundleFd = fs.openSync(bundle, 'r');
    const magic = Buffer.alloc(8);
    try { requireCondition(fs.readSync(bundleFd, magic, 0, 8, 0) === 8, 'bundle-too-small'); }
    finally { fs.closeSync(bundleFd); }
    requireCondition(magic.toString('hex') === 'c61fbc03c103191f', 'hermes-bytecode-required');
    report.bundle = { sha256: fileHash(bundle), bytes: fs.statSync(bundle).size, format: 'Hermes bytecode', magic: magic.toString('hex') };
    if (wasSigned) {
      run('signature-reseal', '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none',
        '--preserve-metadata=identifier,entitlements,flags', app]);
      run('signature-verify', '/usr/bin/codesign', ['--verify', '--strict', app]);
      report.signature.adHocResealed = true;
    }
    await assertNoMetro();
    report.packagerPort = { host: '127.0.0.1', port: 8081, observed: 'connection-refused-after-export' };

    const runtimes = JSON.parse(run('simulator-runtimes', 'xcrun', ['simctl', 'list', 'runtimes', '--json']));
    const types = JSON.parse(run('simulator-types', 'xcrun', ['simctl', 'list', 'devicetypes', '--json']));
    const selected = selectSimulator(runtimes, types);
    report.simulator = selected;
    run('container-command-help', 'xcrun', ['simctl', 'help', 'get_app_container']);
    udid = run('simulator-create', 'xcrun', ['simctl', 'create', 'PURAMA Digest ' + runId,
      selected.deviceType.identifier, selected.runtime.identifier]);
    requireCondition(UUID.test(udid), 'invalid-created-simulator');
    report.simulator.udid = udid;
    run('simulator-boot', 'xcrun', ['simctl', 'boot', udid]);
    run('simulator-boot-status', 'xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: 180_000 });
    run('simulator-install', 'xcrun', ['simctl', 'install', udid, app], { timeout: 90_000 });
    const installed = assertOwnedContainer(run('installed-app-container', 'xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app']), udid);
    const installedHash = fileHash(path.join(installed, 'main.jsbundle'));
    requireCondition(installedHash === report.bundle.sha256, 'installed-bundle-mismatch');
    report.bundle.installedSha256 = installedHash;
    const data = assertOwnedContainer(run('installed-data-container', 'xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data']), udid);
    const receiptPath = path.join(data, 'Documents', contract.receiptFile);
    requireCondition(!fs.existsSync(receiptPath), 'receipt-existed-before-launch');
    await assertNoMetro();
    run('simulator-launch', 'xcrun', ['simctl', 'launch', udid, bundleId]);
    run('qualification-deeplink', 'xcrun', ['simctl', 'openurl', udid, scheme + '://iao-qualification']);
    const deadline = performance.now() + RECEIPT_WAIT_MS;
    while (!fs.existsSync(receiptPath) && performance.now() < deadline) await wait(1000);
    requireCondition(fs.existsSync(receiptPath), 'native-receipt-timeout');
    const received = readReceipt(receiptPath);
    fs.writeFileSync(path.join(evidence, 'runtime-receipt.json'), received.content);
    report.runtime = validateReceipt(received.receipt, { runId, commit, notBefore });
    report.runtimeReceiptSha256 = crypto.createHash('sha256').update(received.content).digest('hex');
    requireCondition(fileHash(path.join(installed, 'main.jsbundle')) === report.bundle.sha256, 'installed-bundle-changed');
    report.qualificationPassed = true;
  } catch (error) { failed = true; failure = error; }
  finally {
    try { report.cleanup = cleanupOwnedSimulator(run, udid); }
    catch { report.cleanup = { status: 'FAIL', errorCode: 'cleanup-exception' }; }
    if (!failed && report.cleanup.status !== 'PASS') {
      failed = true;
      failure = Object.assign(new Error('cleanup-not-passed'), { code: 'cleanup-not-passed' });
    }
    report.status = failed ? 'FAIL' : 'PASS';
    report.errorCode = failed ? (typeof failure?.code === 'string' ? failure.code : 'ios-digest-qualification-failed') : null;
    report.finishedAt = new Date().toISOString();
    try { fs.writeFileSync(path.join(evidence, 'host-receipt.json'), JSON.stringify(report, null, 2) + '\n'); }
    catch (error) {
      // An evidence-write failure must fail the run without replacing its first cause.
      if (!failed) { failed = true; failure = error; report.errorCode = 'host-receipt-write-failed'; }
      report.status = 'FAIL';
      console.error('Host receipt could not be preserved; original qualification status:', report.errorCode);
    }
  }
  console.log(JSON.stringify({ status: report.status, runId, commit: report.commit,
    checks: report.runtime ? contract.checks.length : 0, cleanup: report.cleanup.status, errorCode: report.errorCode }));
  if (failed) throw failure;
  return report;
}

module.exports = { validateReceipt, selectSimulator, findDevice, cleanupOwnedSimulator, readReceipt, fileHash,
  assertOwnedContainer, hasExactKeys, versionNumber, assertNoMetro, main };
if (require.main === module) main().catch(error => {
  console.error('iOS digest qualification failed:', typeof error?.code === 'string' ? error.code : 'unavailable');
  process.exitCode = 1;
});
