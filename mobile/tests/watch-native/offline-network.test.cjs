'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = path.resolve(__dirname, '../../scripts/wait-for-android-offline.py');
const runId = '7434e598-cf0b-446b-a091-56d4e15b958c';
const offlineDump = `NetworkProviders for:
  9: TelephonyNetworkFactory[0]

Active default network: none

Current network preferences:
  Default requests:

Current Networks:

Status for known UIDs:

Historical events:
  NetworkAgentInfo{network{100} ni{WIFI CONNECTED} Capabilities: INTERNET&VALIDATED}
`;
// These current-section shapes reproduce both actual API-35 captures: the
// failed run and the earlier green run whose preferences were already 1/0/0.
const activeDump = offlineDump
  .replace('Active default network: none', 'Active default network: 100')
  .replace('Current Networks:\n\n', 'Current Networks:\n  NetworkAgentInfo{network{100} ni{WIFI CONNECTED} Capabilities: INTERNET&VALIDATED}\n\n');
const ready = { airplane: '1\n', wifi: '0\n', data: '0\n', dump: offlineDump };

const fakeAdb = `#!/usr/bin/env python3
import json,os,pathlib,sys,time
p=pathlib.Path(os.environ['ANDROID_NETWORK_TEST_PLAN'])
plan=json.loads(p.read_text())
state_path=p.with_name('state.json')
state=json.loads(state_path.read_text()) if state_path.exists() else {'index':0,'calls':[]}
args=sys.argv[1:]
serial=None
if args[:1]==['-s']:
 serial=args[1];args=args[2:]
state['calls'].append({'args':args,'serial':serial})
frame=plan['frames'][min(state['index'],len(plan['frames'])-1)]
mapping={'airplane_mode_on':'airplane','wifi_on':'wifi','mobile_data':'data'}
if args[:4]==['shell','settings','get','global'] and len(args)==5:
 key=mapping[args[4]]
elif args==['shell','dumpsys','connectivity']:
 key='dump';state['index']+=1
else:
 state_path.write_text(json.dumps(state));sys.stderr.write('Unexpected ADB call');sys.exit(99)
state_path.write_text(json.dumps(state))
if frame.get('delayAt')==key:time.sleep(frame.get('delaySeconds',2))
if frame.get('failAt')==key:
 sys.stderr.write('injected ADB failure');sys.exit(7)
if frame.get('stderrAt')==key:sys.stderr.write('injected unexpected diagnostic')
if frame.get('invalidEncodingAt')==key:
 sys.stdout.buffer.write(bytes([255]));sys.exit(0)
sys.stdout.write(frame[key])
`;

function execute(frames, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-network-observer-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'adb'), fakeAdb, { mode: 0o700 });
    const plan = path.join(root, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify({ frames }));
    const artifacts = path.join(root, 'artifacts');
    const phase = options.phase || 'before-restart';
    const result = spawnSync('python3', [helper, '--artifact-dir', artifacts,
      '--run-id', runId, '--phase', phase,
      '--timeout-seconds', String(options.timeout || 3),
      '--interval-seconds', '0.01'], {
      encoding: 'utf8', timeout: 6000,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        ANDROID_SERIAL: 'emulator-5554', ANDROID_NETWORK_TEST_PLAN: plan },
    });
    assert.equal(result.error, undefined, String(result.error));
    const phaseRoot = path.join(artifacts, 'network-' + phase);
    const receipt = JSON.parse(fs.readFileSync(path.join(phaseRoot, 'receipt.json'), 'utf8'));
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
    for (const item of receipt.observations) {
      const directory = path.join(phaseRoot, 'observation-' + String(item.index).padStart(3, '0'));
      assert.ok(fs.existsSync(directory), 'Every observation must retain its raw ADB evidence');
      for (const [name, command] of Object.entries(item.commands)) {
        for (const [stream, suffix] of [['stdout', '.txt'], ['stderr', '.stderr.txt']]) {
          const bytes = fs.readFileSync(path.join(directory, name + suffix));
          assert.equal(bytes.length, command[stream + 'Bytes']);
          assert.equal(createHash('sha256').update(bytes).digest('hex'), command[stream + 'Sha256']);
        }
      }
    }
    return { exit: result.status, receipt, calls: state.calls, stdout: result.stdout };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('requires three stable offline observations and ignores historical CONNECTED text', () => {
  const { exit, receipt, calls } = execute([ready]);
  assert.equal(exit, 0);
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.stableObservations, 3);
  assert.equal(receipt.observations.length, 3);
  assert.equal(calls.length, 12);
  assert.ok(calls.every(call => call.serial === 'emulator-5554'));
  assert.ok(calls.every(call => ['get', 'connectivity'].some(word => call.args.includes(word))),
    'The observer must never write a setting or invoke a provider');
});

test('recognizes the same exact AOSP sections with CRLF line endings', () => {
  const { exit, receipt } = execute([{ ...ready, dump: offlineDump.replaceAll('\n', '\r\n') }]);
  assert.equal(exit, 0);
  assert.equal(receipt.stableObservations, 3);
});

test('waits for actual live network removal after preferences have already changed', () => {
  const { exit, receipt } = execute([
    { ...ready, data: '1\n', dump: activeDump },
    { ...ready, dump: activeDump }, ready, ready, ready,
  ]);
  assert.equal(exit, 0);
  assert.equal(receipt.observations.length, 5);
  assert.deepEqual(receipt.observations.map(item => item.offline), [false, false, true, true, true]);
});

test('a radio or network rebound resets the stability requirement', () => {
  const { exit, receipt } = execute([ready, ready, { ...ready, dump: activeDump }, ready, ready, ready]);
  assert.equal(exit, 0);
  assert.equal(receipt.observations.length, 6);
  assert.equal(receipt.stableObservations, 3);
});

test('never accepts mobile data still enabled, even if the live network set is empty', () => {
  const { exit, receipt } = execute([{ ...ready, data: '1\n' }], { timeout: 0.4 });
  assert.equal(exit, 23);
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.stableObservations, 0);
  assert.ok(receipt.elapsedSeconds < 1.5, 'The observer must honor its finite deadline');
});

test('never accepts an active default network with disabled radio preferences', () => {
  const { exit, receipt } = execute([{ ...ready, dump: activeDump }], { timeout: 0.4 });
  assert.equal(exit, 23);
  assert.equal(receipt.status, 'FAIL');
  assert.ok(receipt.observations.some(item => item.connectivity?.activeDefaultNetwork === 100));
});

test('rejects a remaining per-app or local network even without a system-default network', () => {
  const dump = activeDump.replace('Active default network: 100', 'Active default network: none');
  const { exit, receipt } = execute([{ ...ready, dump }], { phase: 'after-restart' });
  assert.equal(exit, 23);
  assert.equal(receipt.observations.length, 1);
  assert.equal(receipt.reason, 'network_returned_after_offline_boundary');
});

for (const phase of ['after-restart', 'after-completion']) {
  test(phase + ' requires three fresh stable observations of the same run', () => {
    const { exit, receipt } = execute([ready], { phase });
    assert.equal(exit, 0);
    assert.equal(receipt.mode, 'assert');
    assert.equal(receipt.phase, phase);
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.observations.length, 3);
  });
  test(phase + ' fails immediately on a returning network rather than waiting it away', () => {
    const { exit, receipt } = execute([ready, { ...ready, dump: activeDump }, ready, ready, ready], { phase });
    assert.equal(exit, 23);
    assert.equal(receipt.mode, 'assert');
    assert.equal(receipt.observations.length, 2);
    assert.equal(receipt.reason, 'network_returned_after_offline_boundary');
  });
}

for (const [name, dump] of [
  ['absent current sections', 'Permission Denial: not allowed to dump connectivity\n'],
  ['unknown null default', offlineDump.replace('network: none', 'network: null')],
  ['duplicated default section', 'Active default network: none\n' + offlineDump],
  ['missing section terminator', offlineDump.replace('Status for known UIDs:', 'Different future format:')],
  ['duplicated current section', offlineDump + '\nCurrent Networks:\n'],
  ['default section after the current section', offlineDump.replace('Active default network: none\n', '') + '\nActive default network: none\n'],
  ['current section after the terminator', offlineDump.replace('Current Networks:', 'Status for known UIDs:').replace('Status for known UIDs:\n\nHistorical', 'Current Networks:\n\nHistorical')],
]) {
  test('fails closed for ' + name, () => {
    const { exit, receipt } = execute([{ ...ready, dump }]);
    assert.equal(exit, 23);
    assert.equal(receipt.reason, 'unknown_connectivity_format');
    assert.equal(receipt.observations.length, 1);
  });
}

test('unknown radio settings cannot become proof of isolation', () => {
  const { exit, receipt } = execute([{ ...ready, wifi: 'null\n' }]);
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'unknown_radio_setting');
});

test('ADB failures are recorded and cannot reuse a previous offline observation', () => {
  const { exit, receipt } = execute([ready, { ...ready, failAt: 'data' }, ready]);
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'adb_observation_failed');
  assert.equal(receipt.observations.length, 2);
  assert.equal(receipt.observations[1].commands['mobile-data'].exitCode, 7);
});

test('a blocked ADB call is killed within the remaining observation budget', () => {
  const { exit, receipt } = execute([{ ...ready, delayAt: 'airplane', delaySeconds: 2 }], { timeout: 0.3 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'adb_observation_failed');
  assert.equal(receipt.observations[0].commands['airplane-mode'].exitCode, 124);
  assert.ok(receipt.elapsedSeconds < 1.2);
});

test('unexpected ADB stderr remains a failure even with plausible stdout', () => {
  const { exit, receipt } = execute([{ ...ready, stderrAt: 'dump' }]);
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'adb_observation_stderr');
});

test('invalid UTF-8 output fails closed and keeps the raw command evidence', () => {
  const { exit, receipt } = execute([{ ...ready, invalidEncodingAt: 'dump' }]);
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'invalid_adb_output_encoding');
  assert.equal(receipt.observations[0].commands['connectivity-offline'].stdoutBytes, 1);
});
