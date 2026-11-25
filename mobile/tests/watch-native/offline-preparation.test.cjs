'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = path.resolve(__dirname, '../../scripts/prepare-android-offline.py');
const runId = '7434e598-cf0b-446b-a091-56d4e15b958c';
const dataDisable = ['shell', 'svc', 'data', 'disable'];
const airplaneEnable = ['shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'];
const isubCommand = ['shell', 'dumpsys', 'isub'];
const telephonyDebug = ['shell', 'dumpsys', 'activity', 'service', 'TelephonyDebugService'];
const readyIsub = `SubscriptionManagerService:
Active modem count=2
Logical SIM slot sub id mapping:
  Logical SIM slot 0: subId=1
  Logical SIM slot 1: subId=2
ICCID:
  slot 0: synthetic
  slot 1: synthetic
defaultSubId=1
defaultDataSubId=1
activeDataSubId=-1
areAllSubscriptionsLoaded=true
`;
const pendingIsub = readyIsub.replace('defaultDataSubId=1', 'defaultDataSubId=-1');
const fakeAdb = `#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys,time
p=pathlib.Path(os.environ['ANDROID_PREPARATION_TEST_PLAN'])
plan=json.loads(p.read_text())
state_path=p.with_name('state.json')
state=json.loads(state_path.read_text()) if state_path.exists() else {'calls':[],'settings':{'airplane_mode_on':'0','wifi_on':'1','mobile_data':'1','mobile_data1':'1','mobile_data2':'0','multi_sim_data_call':'1','device_provisioned':'1','device_provisioning_mobile_data':'1'}}
args=sys.argv[1:]
serial=None
if args[:1]==['-s']:
 serial=args[1];args=args[2:]
if not state['calls']:state['settings'].update(plan.get('settings',{}))
state['calls'].append({'args':args,'serial':serial})
occurrence=sum(call['args']==args for call in state['calls'])
state_path.write_text(json.dumps(state))
if args==plan.get('delayAt') and occurrence==plan.get('delayAtOccurrence',occurrence):
 sys.stdout.write('partial before timeout\\n');sys.stdout.flush()
 time.sleep(5)
if args==plan.get('forkAt'):
 subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)'])
 sys.exit(0)
if args==plan.get('failAt') and occurrence==plan.get('failAtOccurrence',occurrence):
 sys.stdout.write('partial failed output\\n');sys.stderr.write('synthetic ADB failure\\n');sys.exit(7)
if args==plan.get('stderrAt'):
 sys.stderr.write('synthetic unexpected stderr\\n')
if args==plan.get('invalidAt'):
 sys.stdout.buffer.write(bytes([255]));sys.exit(0)
if args==plan.get('overflowAt'):
 sys.stdout.buffer.write(b'x'*(3*1024*1024));sys.stdout.flush();sys.exit(0)
if args==['get-serialno']:
 sys.stdout.write('emulator-5554\\n')
elif args[:2]==['shell','getprop']:
 props={'ro.kernel.qemu':plan.get('qemu','1'),'ro.build.version.sdk':'35','ro.product.cpu.abi':'x86_64','ro.build.fingerprint':'synthetic-api35-fingerprint'}
 sys.stdout.write(props[args[2]]+'\\n')
elif args==['shell','cmd','phone','help']:
 sys.stdout.write('Synthetic phone help: data enable/disable\\n');sys.exit(255)
elif args==['shell','dumpsys','isub']:
 frames=plan.get('isubFrames',[plan.get('isub',plan['defaultIsub'])])
 sys.stdout.write(frames[min(occurrence-1,len(frames)-1)])
elif args==['shell','dumpsys','phone']:
 sys.stdout.write('DataSettingsManager-0:\\n  isUserDataEnabled='+str(state['settings']['mobile_data1']=='1').lower()+'\\n  device_provisioned=1\\n')
elif args==['shell','dumpsys','activity','service','TelephonyDebugService']:
 sys.stdout.write('Synthetic TelephonyDebugService: carrier config pending\\n')
elif args[:4]==['shell','settings','get','global'] and len(args)==5:
 sys.stdout.write(state['settings'].get(args[4],'null')+'\\n')
elif args==['shell','svc','wifi','disable']:
 state['settings']['wifi_on']='0'
elif args==['shell','svc','data','disable']:
 state['settings']['mobile_data1']='0'
elif args==['shell','cmd','connectivity','airplane-mode','enable']:
 state['settings']['airplane_mode_on']='1'
elif args==['shell','settings','put','global','airplane_mode_on','1']:
 state['settings']['airplane_mode_on']='1'
elif args==['reverse','--remove-all']:
 pass
else:
 sys.stderr.write('Unexpected synthetic ADB command');sys.exit(99)
state_path.write_text(json.dumps(state))
`;

function execute(plan = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-network-preparation-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'adb'), fakeAdb, { mode: 0o700 });
    const planPath = path.join(root, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({ defaultIsub: readyIsub, ...plan }));
    const artifacts = path.join(root, 'artifacts');
    const evidence = path.join(artifacts, 'network-preparation');
    if (options.existing) {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'receipt.json'), options.existing);
    }
    const args = [helper, '--artifact-dir', artifacts, '--run-id', options.runId ?? runId,
      '--timeout-seconds', String(options.timeout ?? 8)];
    if (options.inspectOnly) args.push('--inspect-only');
    const started = performance.now();
    const result = spawnSync('python3', args, {
      encoding: 'utf8', timeout: 12000,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        ANDROID_SERIAL: options.serial ?? 'emulator-5554', ANDROID_PREPARATION_TEST_PLAN: planPath },
    });
    const wallSeconds = (performance.now() - started) / 1000;
    assert.equal(result.error, undefined, String(result.error));
    const statePath = path.join(root, 'state.json');
    const calls = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')).calls : [];
    const receiptPath = path.join(evidence, 'receipt.json');
    const rawReceipt = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, 'utf8') : null;
    const receipt = rawReceipt && !options.existing ? JSON.parse(rawReceipt) : null;
    const raw = {};
    for (const command of receipt?.commands || []) {
      raw[command.name] = {};
      for (const [stream, suffix] of [['stdout', '.txt'], ['stderr', '.stderr.txt']]) {
        const bytes = fs.readFileSync(path.join(evidence, command.name + suffix));
        raw[command.name][stream] = bytes;
        assert.equal(bytes.length, command[stream + 'Bytes']);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), command[stream + 'Sha256']);
      }
    }
    return { exit: result.status, receipt, rawReceipt, calls, raw, wallSeconds,
      stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function mutationCalls(calls) {
  return calls.filter(({ args }) => args.includes('disable') || args.includes('enable') ||
    args.includes('put') || args[0] === 'reverse').map(({ args }) => args);
}

test('synthetic preparation records commands and subscription evidence without certifying isolation', () => {
  const { exit, receipt, calls } = execute();
  assert.equal(exit, 0);
  assert.equal(receipt.status, 'COMMANDS_COMPLETED');
  assert.equal(receipt.networkVerified, false);
  assert.equal(receipt.runId, runId);
  assert.ok(calls.every(call => call.serial === 'emulator-5554'));
  assert.deepEqual(receipt.snapshots.map(snapshot => snapshot.phase), ['before', 'after-data', 'after-airplane']);
  assert.equal(receipt.snapshots[1].settings.mobile_data, '1');
  assert.equal(receipt.snapshots[1].settings.mobile_data1, '0');
  assert.equal(receipt.snapshots[1].settings.airplane_mode_on, '0');
  assert.deepEqual(receipt.snapshots[1].subscriptionIds, [1, 2]);
  assert.deepEqual(mutationCalls(calls), [
    ['shell', 'svc', 'wifi', 'disable'], dataDisable, airplaneEnable,
    ['shell', 'settings', 'put', 'global', 'airplane_mode_on', '1'], ['reverse', '--remove-all'],
  ]);
  const afterData = calls.findIndex(call => JSON.stringify(call.args) === JSON.stringify(dataDisable));
  const airplane = calls.findIndex(call => JSON.stringify(call.args) === JSON.stringify(airplaneEnable));
  assert.ok(calls.slice(afterData + 1, airplane).some(call => call.args.join(' ') === 'shell dumpsys phone'));
  assert.ok(calls.slice(afterData + 1, airplane).some(call => call.args.join(' ') === 'shell dumpsys isub'));
  assert.ok(calls.every(call => !(call.args.includes('put') && call.args.some(word => word.startsWith('mobile_data')))));
  assert.ok(calls.every(call => !call.args.includes('list')), 'Only relevant settings may be collected');
});

test('read-only inspection reports OBSERVED and never mutates any radio', () => {
  const { exit, receipt, calls, raw } = execute({}, { inspectOnly: true });
  assert.equal(exit, 0);
  assert.equal(receipt.status, 'OBSERVED');
  assert.equal(receipt.networkVerified, false);
  assert.equal(receipt.mutationAttempted, false);
  assert.deepEqual(mutationCalls(calls), []);
  assert.deepEqual(receipt.snapshots.map(snapshot => snapshot.phase), ['observed']);
  assert.equal(raw['identity/fingerprint'].stdout.toString(), 'synthetic-api35-fingerprint\n');
  assert.equal(raw['identity/api'].stdout.toString(), '35\n');
  assert.equal(raw['identity/abi'].stdout.toString(), 'x86_64\n');
});

for (const qemu of ['0', '', 'unknown']) {
  test('refuses physical or unrecognized device flag ' + JSON.stringify(qemu) + ' before mutation', () => {
    const { exit, receipt, calls } = execute({ qemu });
    assert.equal(exit, 23);
    assert.equal(receipt.reason, 'refused_non_emulator');
    assert.equal(receipt.emulatorVerified, false);
    assert.equal(calls.length, 1);
    assert.deepEqual(mutationCalls(calls), []);
  });
}

test('read-only inspection also refuses a physical device before private diagnostics', () => {
  const { exit, calls } = execute({ qemu: '0' }, { inspectOnly: true });
  assert.equal(exit, 23);
  assert.equal(calls.length, 1);
});

test('data-control failure retains both streams and post-failure diagnostics without enabling airplane mode', () => {
  const { exit, receipt, calls, raw } = execute({ failAt: dataDisable });
  assert.equal(exit, 23);
  assert.equal(receipt.status, 'FAIL');
  assert.equal(receipt.reason, 'command_failed');
  assert.equal(receipt.failedCommand, 'controls/data-disable');
  assert.equal(receipt.commands.find(command => command.name === receipt.failedCommand).exitCode, 7);
  assert.equal(raw[receipt.failedCommand].stdout.toString(), 'partial failed output\n');
  assert.equal(raw[receipt.failedCommand].stderr.toString(), 'synthetic ADB failure\n');
  assert.ok(receipt.snapshots.some(snapshot => snapshot.phase === 'on-failure'));
  assert.ok(!mutationCalls(calls).some(args => JSON.stringify(args) === JSON.stringify(airplaneEnable)));
});

test('zero exit with unexpected stderr is preserved as a control failure', () => {
  const { exit, receipt } = execute({ stderrAt: dataDisable });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'unexpected_command_stderr');
  assert.equal(receipt.commands.find(command => command.name === receipt.failedCommand).exitCode, 0);
});

test('blocked ADB control consumes only the remaining global budget and preserves partial output', () => {
  const { exit, receipt, raw, wallSeconds } = execute({ delayAt: dataDisable }, { timeout: 1.3 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'command_timeout');
  assert.equal(receipt.failedCommand, 'controls/data-disable');
  assert.equal(raw[receipt.failedCommand].stdout.toString(), 'partial before timeout\n');
  assert.ok(wallSeconds < 2.0, 'One global deadline includes all diagnostics and controls');
});

test('a child retaining inherited pipes cannot outlive the global ADB budget', () => {
  const guard = ['shell', 'getprop', 'ro.kernel.qemu'];
  const { exit, receipt, wallSeconds } = execute({ forkAt: guard }, { timeout: 0.5 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'command_timeout');
  assert.ok(wallSeconds < 1.1);
});

test('oversized diagnostics are bounded while streaming and cannot precede a mutation', () => {
  const { exit, receipt, raw, calls } = execute({ overflowAt: ['shell', 'dumpsys', 'phone'] });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'command_output_limit');
  const command = receipt.commands.find(item => item.name === receipt.failedCommand);
  assert.equal(command.stdoutTruncated, true);
  assert.equal(raw[command.name].stdout.length, 2 * 1024 * 1024);
  assert.deepEqual(mutationCalls(calls), []);
});

test('invalid guard encoding cannot become emulator authorization', () => {
  const { exit, receipt, calls } = execute({ invalidAt: ['shell', 'getprop', 'ro.kernel.qemu'] });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'invalid_command_encoding');
  assert.deepEqual(mutationCalls(calls), []);
});

test('an implicit default device is resolved once then pinned before the emulator guard', () => {
  const { exit, calls } = execute({}, { inspectOnly: true, serial: '' });
  assert.equal(exit, 0);
  assert.deepEqual(calls[0], { args: ['get-serialno'], serial: null });
  assert.ok(calls.slice(1).every(call => call.serial === 'emulator-5554'));
});

for (const options of [
  { runId: 'not-a-uuid' }, { runId: runId.toUpperCase() },
  { timeout: 'NaN' }, { timeout: 'Infinity' }, { timeout: 0 }, { timeout: 61 },
]) {
  test('rejects invalid run identity or unbounded deadline ' + JSON.stringify(options), () => {
    const { exit, calls, receipt } = execute({}, options);
    assert.equal(exit, 2);
    assert.deepEqual(calls, []);
    assert.equal(receipt, null);
  });
}

test('a second invocation cannot overwrite an earlier preparation receipt', () => {
  const existing = '{"prior":"unaltered evidence"}\n';
  const { exit, calls, rawReceipt } = execute({}, { existing, inspectOnly: true });
  assert.equal(exit, 2);
  assert.deepEqual(calls, []);
  assert.equal(rawReceipt, existing);
});

test('DATA readiness waits for a mapped default before the first mutation', () => {
  const { exit, receipt, calls } = execute({ isubFrames: [pendingIsub, pendingIsub, readyIsub] });
  assert.equal(exit, 0);
  assert.equal(receipt.dataReadiness.status, 'READY');
  assert.deepEqual(receipt.dataReadiness.observations.map(item => item.status), ['WAITING', 'READY']);
  assert.equal(receipt.dataReadiness.observations[0].defaultDataSubId, -1);
  assert.equal(receipt.dataReadiness.observations[1].defaultDataSubId, 1);
  const firstMutation = calls.findIndex(call => mutationCalls([call]).length > 0);
  assert.equal(calls.slice(0, firstMutation).filter(call => call.args.join(' ') === isubCommand.join(' ')).length, 3);
  assert.ok(receipt.dataReadiness.timeoutSeconds <= 30);
  assert.ok(receipt.dataReadiness.reservedSeconds > 0);
});

test('DATA readiness expires before mutation and retains a bounded telephony diagnostic', () => {
  const { exit, receipt, calls, raw, wallSeconds } = execute({ isub: pendingIsub }, { timeout: 2 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'data_subscription_not_ready');
  assert.equal(receipt.dataReadiness.status, 'FAIL');
  assert.ok(receipt.dataReadiness.observations.length > 0);
  assert.ok(receipt.dataReadiness.observations.every(item => item.defaultDataSubId === -1));
  assert.deepEqual(mutationCalls(calls), []);
  assert.equal(receipt.dataReadiness.diagnostic.status, 'OBSERVED');
  assert.match(raw['data-readiness/telephony-debug'].stdout.toString(), /carrier config pending/);
  assert.ok(wallSeconds < 2.8, 'Readiness and its diagnostic share the existing global deadline');
});

for (const [label, isub, reason] of [
  ['missing DATA default', readyIsub.replace('defaultDataSubId=1\n', ''), 'missing_default_data_subscription'],
  ['conflicting DATA defaults', readyIsub + 'defaultDataSubId=2\n', 'ambiguous_default_data_subscription'],
  ['duplicated DATA default', readyIsub + 'defaultDataSubId=1\n', 'ambiguous_default_data_subscription'],
  ['unmapped DATA default', readyIsub.replace('defaultDataSubId=1', 'defaultDataSubId=99'), 'default_data_not_mapped'],
  ['duplicated active slot', readyIsub.replace('Logical SIM slot 1: subId=2', 'Logical SIM slot 0: subId=2'), 'ambiguous_active_subscription_mapping'],
  ['unknown mapping section', readyIsub.replace('Logical SIM slot sub id mapping:', 'Different future mapping:'), 'unknown_subscription_mapping'],
]) {
  test('DATA readiness refuses ' + label + ' before mutation', () => {
    const { exit, receipt, calls } = execute({ isub });
    assert.equal(exit, 23);
    assert.equal(receipt.reason, reason);
    assert.deepEqual(mutationCalls(calls), []);
    assert.equal(receipt.dataReadiness.observations[0].status, 'INVALID');
    assert.equal(receipt.dataReadiness.diagnostic.status, 'OBSERVED');
  });
}

test('DATA readiness accepts a mapped default without active DATA or provisioning', () => {
  const { exit, receipt } = execute({ settings: { device_provisioned: '0', multi_sim_data_call: 'null' } });
  assert.equal(exit, 0);
  assert.equal(receipt.dataReadiness.status, 'READY');
  assert.equal(receipt.snapshots[0].settings.device_provisioned, '0');
  assert.equal(receipt.networkVerified, false);
});

test('DATA readiness is never awaited or diagnosed in inspect-only mode', () => {
  const { exit, receipt, calls } = execute({ isub: pendingIsub }, { inspectOnly: true });
  assert.equal(exit, 0);
  assert.equal(receipt.status, 'OBSERVED');
  assert.equal(receipt.dataReadiness, undefined);
  assert.equal(calls.filter(call => call.args.join(' ') === isubCommand.join(' ')).length, 1);
  assert.ok(!calls.some(call => call.args.join(' ') === telephonyDebug.join(' ')));
  assert.deepEqual(mutationCalls(calls), []);
});

test('DATA readiness keeps its original failure when the diagnostic also fails', () => {
  const { exit, receipt, calls, raw } = execute({ isub: pendingIsub, failAt: telephonyDebug }, { timeout: 2 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'data_subscription_not_ready');
  assert.equal(receipt.dataReadiness.diagnostic.status, 'FAIL');
  assert.equal(receipt.dataReadiness.diagnostic.reason, 'command_failed');
  assert.match(raw['data-readiness/telephony-debug'].stderr.toString(), /synthetic ADB failure/);
  assert.deepEqual(mutationCalls(calls), []);
});

test('DATA readiness preserves a failed ADB observation before any mutation', () => {
  const { exit, receipt, calls, raw } = execute({ failAt: isubCommand, failAtOccurrence: 2 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'command_failed');
  assert.match(receipt.failedCommand, /^data-readiness\/observation-001\/isub$/);
  assert.equal(receipt.dataReadiness.observations[0].status, 'ERROR');
  assert.match(raw[receipt.failedCommand].stderr.toString(), /synthetic ADB failure/);
  assert.deepEqual(mutationCalls(calls), []);
});

test('DATA readiness bounds a blocked observation and still reserves time for diagnostics', () => {
  const { exit, receipt, calls, raw, wallSeconds } = execute({ delayAt: isubCommand, delayAtOccurrence: 2 }, { timeout: 2 });
  assert.equal(exit, 23);
  assert.equal(receipt.reason, 'command_timeout');
  assert.match(receipt.failedCommand, /^data-readiness\/observation-001\/isub$/);
  assert.match(raw[receipt.failedCommand].stdout.toString(), /partial before timeout/);
  assert.equal(receipt.dataReadiness.diagnostic.status, 'OBSERVED');
  assert.deepEqual(mutationCalls(calls), []);
  assert.ok(wallSeconds < 2.8);
});
