'use strict';

// Exercises the real Python parser and process boundary. No emulator, provider
// request, product code, original preflight or offline observer is modified.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const helper = path.resolve(__dirname, '../../scripts/qualify-android-data-settings.py');
const runId = '7434e598-cf0b-446b-a091-56d4e15b958c';
const fingerprint = 'google/sdk_gphone64_x86_64/emu64xa:15/AE3A.240806.043/12960925:userdebug/dev-keys';
const component = 'com.android.settings/.Settings$MobileNetworkActivity';
const isub = `SubscriptionManagerService:
Active modem count=1
Logical SIM slot sub id mapping:
  Logical SIM slot 0: subId=1
ICCID:
  slot 0: synthetic
defaultSubId=1
defaultDataSubId=-1
activeDataSubId=-1
areAllSubscriptionsLoaded=true
`;

function ui({ top = 400, title = 'Mobile data', switchId = 'com.android.settings:id/switchWidget',
  checked = 'CHECKED_STATE', enabled = 'true', extra = '', titlePackage = 'com.android.settings' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.settings" enabled="true" clickable="false" bounds="[0,0][1080,2400]">
<node class="android.widget.LinearLayout" package="com.android.settings" enabled="${enabled}" clickable="true" bounds="[0,${top}][1080,${top + 200}]">
<node text="${title}" resource-id="android:id/title" class="android.widget.TextView" package="${titlePackage}" enabled="true" clickable="false" bounds="[20,${top + 10}][750,${top + 50}]"/>
<node resource-id="${switchId}" class="android.widget.Switch" package="com.android.settings" enabled="true" checkable="true" checked="${checked}" clickable="false" bounds="[850,${top + 30}][1030,${top + 100}]"/>
</node>${extra}</node></hierarchy>`;
}

const fakeAdb = `#!/usr/bin/env python3
import base64,json,os,pathlib,shlex,sys,time
p=pathlib.Path(os.environ['PURAMA_SETTINGS_TEST_PLAN'])
plan=json.loads(p.read_text());state_path=p.with_name('state.json')
state=json.loads(state_path.read_text()) if state_path.exists() else {'calls':[],'clicks':0,'checked':plan.get('initialChecked',True),'selected':False,'isubReads':0}
args=sys.argv[1:];serial=None
if args[:1]==['-s']:serial=args[1];args=args[2:]
if args[:1]==['shell'] and len(args)==2:args=['shell']+shlex.split(args[1])
state['calls'].append({'args':args,'serial':serial});state_path.write_text(json.dumps(state))
if args==plan.get('delayAt'):time.sleep(20)
if args==plan.get('stderrAt'):sys.stderr.write('synthetic command warning');sys.exit(0)
if args==plan.get('invalidAt'):sys.stdout.buffer.write(bytes([255]));sys.exit(0)
if args==plan.get('overflowAt'):sys.stdout.buffer.write(b'x'*(3*1024*1024));sys.stdout.flush();sys.exit(0)
if args==plan.get('failAt'):sys.exit(9)
if args==plan.get('changeOriginalAt'):
 original=pathlib.Path(plan['originalPath']);original.write_bytes(original.read_bytes()+b' ')
if args==['get-serialno']:print(plan.get('serial','emulator-5554'))
elif args[:2]==['shell','getprop']:
 props={'ro.kernel.qemu':plan.get('qemu','1'),'ro.build.version.sdk':plan.get('api','35'),'ro.product.cpu.abi':'x86_64','ro.build.fingerprint':plan.get('fingerprint',plan['fingerprintDefault']),'gsm.sim.state':plan.get('sim','LOADED')}
 print(props[args[2]])
elif args==['shell','am','get-current-user']:print(plan.get('user','0'))
elif args==['shell','dumpsys','isub']:
 state['isubReads']+=1
 text=plan.get('isub',plan['defaultIsub'])
 if plan.get('changeSubscription') and state['isubReads']>=2:text=text.replace('subId=1','subId=2')
 if state['selected'] or plan.get('alreadyReady'):text=text.replace('defaultDataSubId=-1','defaultDataSubId=1')
 print(text,end='')
elif args[:4]==['shell','cmd','package','resolve-activity']:
 print(plan.get('resolved',plan['component']))
elif args[:3]==['shell','am','start']:
 print('Starting: synthetic intent\\nStatus: '+plan.get('launchStatus','ok')+'\\nActivity: '+plan['component'])
elif args==['shell','dumpsys','window','windows']:
 focused=plan.get('focus',plan['component'])
 if plan.get('overlayAfterClick') and state['clicks']:focused='com.android.permissioncontroller/.UnexpectedDialog'
 print('  mCurrentFocus=Window{abc u0 '+focused+'}')
elif args==['shell','wm','size']:print(plan.get('display','Physical size: 1080x2400'))
elif args[:3]==['shell','uiautomator','dump']:print('UI hierarchy dumped to: '+args[3])
elif args[:2]==['exec-out','cat']:
 xml=plan.get('xmlAfterClick',plan['xml']) if state['clicks'] else plan['xml']
 if plan.get('moveBeforeClick') and state['isubReads']>=2:xml=plan['movedXml']
 checked=plan.get('frozenUiState',state['checked'])
 if state['clicks'] and state.get('uiSinceClick',0)<plan.get('delayedUiObservations',0):checked=state['previousChecked']
 state['uiSinceClick']=state.get('uiSinceClick',0)+1
 print(xml.replace('CHECKED_STATE',str(checked).lower()),end='')
elif args[:3]==['shell','input','tap']:
 state['previousChecked']=state['checked'];state['uiSinceClick']=0
 state['clicks']+=1
 if not plan.get('moveBeforeClick') or args[-2:]==['385','930']:state['checked']=not state['checked']
 if state['checked'] and plan.get('selectData',True):state['selected']=True
elif args==['exec-out','screencap','-p']:
 sys.stdout.buffer.write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='))
else:
 sys.stderr.write('unexpected synthetic ADB command: '+repr(args));sys.exit(17)
state_path.write_text(json.dumps(state))
`;

function execute(plan = {}, options = {}, inspect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purama-data-settings-'));
  try {
    const artifacts = path.join(root, 'preflight');
    fs.mkdirSync(path.join(artifacts, 'network-preparation'), { recursive: true });
    const originalPath = path.join(artifacts, 'network-preparation', 'receipt.json');
    const original = {
      schema: 1, phase: 'network-preparation', mode: 'prepare', status: 'FAIL',
      reason: 'data_subscription_not_ready', runId, finishedAt: new Date().toISOString(),
      emulatorVerified: true, mutationAttempted: false, networkVerified: false,
      adb: ['adb', '-s', 'emulator-5554'],
      dataReadiness: { status: 'FAIL', reason: 'data_subscription_not_ready',
        observations: [{ status: 'WAITING', defaultDataSubId: -1 }] },
      ...options.original,
    };
    fs.writeFileSync(originalPath, JSON.stringify(original, null, 2) + '\n');
    const originalBytes = fs.readFileSync(originalPath);
    fs.writeFileSync(path.join(artifacts, 'system-image-source.properties'), options.properties ??
      'Pkg.Revision=9\nAndroidVersion.ApiLevel=35\nAndroidVersion.ExtensionLevel=13\nSystemImage.Abi=x86_64\nSystemImage.TagId=google_apis\n');
    fs.writeFileSync(path.join(artifacts, 'checkout.txt'),
      '271f40b666c11d90fe4a350a41432513a08fc72f\nae5d147a47012799caa1822be4d327767a215b82\n');
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'adb'), fakeAdb, { mode: 0o755 });
    const planPath = path.join(root, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({ defaultIsub: isub, xml: ui(), component,
      fingerprintDefault: fingerprint, originalPath, ...plan }));
    const args = ['-B', helper, '--artifact-dir', artifacts, '--timeout-seconds', String(options.timeout ?? 6)];
    if (options.allow !== false) args.push('--allow-settings-transition');
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      ANDROID_SERIAL: options.serial ?? 'emulator-5554', PURAMA_SETTINGS_TEST_PLAN: planPath };
    const started = performance.now();
    const result = spawnSync('python3', args, { env, encoding: 'utf8', timeout: 12000 });
    assert.equal(result.error, undefined, String(result.error));
    const receiptPath = path.join(artifacts, 'data-settings-qualification', 'receipt.json');
    const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;
    const statePath = path.join(root, 'state.json');
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { calls: [], clicks: 0 };
    const value = { exit: result.status, stdout: result.stdout, stderr: result.stderr, receipt,
      state, calls: state.calls, seconds: (performance.now() - started) / 1000,
      originalUnchanged: originalBytes.equals(fs.readFileSync(originalPath)), artifacts };
    if (inspect) inspect(value, { args, env, originalPath, receiptPath });
    return value;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function clicks(value) { return value.calls.filter(call => call.args.slice(0, 3).join(' ') === 'shell input tap'); }
function launches(value) { return value.calls.filter(call => call.args.slice(0, 3).join(' ') === 'shell am start'); }
function assertFailure(value, reason) {
  assert.equal(value.exit, 24, value.stderr);
  assert.equal(value.receipt.status, 'FAIL');
  if (reason) assert.equal(value.receipt.reason, reason);
  assert.equal(value.receipt.networkVerified, false);
  assert.equal(value.originalUnchanged, true);
}

test('explicit authorization is required: original failure preserved and zero ADB commands by default', () => {
  const result = execute({}, { allow: false });
  assert.equal(result.exit, 24);
  assert.equal(result.receipt.status, 'NOT_ATTEMPTED');
  assert.equal(result.receipt.mutationAttempted, false);
  assert.equal(result.receipt.initialFailurePreserved, true);
  assert.equal(result.originalUnchanged, true);
  assert.deepEqual(result.calls, []);
});

test('observed ON → OFF → ON uses two fresh UI states and preserves original FAIL with raw trace hashes', () => {
  execute({}, {}, result => {
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.receipt.status, 'DATA_SELECTION_OBSERVED');
    assert.equal(result.receipt.networkVerified, false);
    assert.equal(result.receipt.origin.status, 'FAIL');
    assert.equal(result.receipt.selectionAttempts, 1);
    assert.equal(result.receipt.uiClicks, 2);
    assert.deepEqual(result.receipt.uiObservations.filter(x => x.purpose === 'initial' || x.purpose.startsWith('after-click-'))
      .map(x => x.control.checked), [true, false, true]);
    assert.equal(result.originalUnchanged, true);
    assert.ok(result.calls.every(call => call.serial === 'emulator-5554'));
    assert.equal(launches(result).length, 1);
    assert.ok(launches(result)[0].args.includes(component));
    for (const command of result.receipt.commands) {
      const suffix = command.command.includes('screencap') ? '.png' : '.txt';
      const stdout = fs.readFileSync(path.join(result.artifacts, 'data-settings-qualification', command.name + suffix));
      const stderr = fs.readFileSync(path.join(result.artifacts, 'data-settings-qualification', command.name + '.stderr.txt'));
      assert.equal(stdout.length, command.stdoutBytes);
      assert.equal(crypto.createHash('sha256').update(stdout).digest('hex'), command.stdoutSha256);
      assert.equal(stderr.length, command.stderrBytes);
      assert.equal(crypto.createHash('sha256').update(stderr).digest('hex'), command.stderrSha256);
      assert.equal(command.failure, null);
    }
    assert.ok(result.calls.every(call => !call.args.includes('svc') && !call.args.includes('service') &&
      !(call.args.includes('settings') && call.args.includes('put')) && !call.args.includes('phone')));
  });
});

test('observed OFF → ON needs only one click on bounds from the actual dump', () => {
  const result = execute({ initialChecked: false, xml: ui({ top: 700 }) });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.receipt.uiClicks, 1);
  assert.deepEqual(clicks(result)[0].args, ['shell', 'input', 'tap', '385', '730']);
});

test('a recreated row is re-read between OFF and ON; second click follows its new bounds', () => {
  const result = execute({ xmlAfterClick: ui({ top: 900 }) });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(clicks(result).map(x => x.args.slice(-2)), [['385', '430'], ['385', '930']]);
});

test('two asynchronous UI transitions can each consume three observations within the shared bound', () => {
  const result = execute({ delayedUiObservations: 2 });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.receipt.uiObservations.length, 9);
  assert.equal(result.receipt.uiClicks, 2);
  assert.equal(result.receipt.selectionAttempts, 1);
  assert.ok(result.seconds < 6.5, String(result.seconds));
});

for (const timeout of [0, -1, 61, 'NaN']) {
  test('invalid global timeout ' + timeout + ' is rejected before any diagnostic dispatch', () => {
    const result = execute({}, { timeout });
    assert.equal(result.exit, 2);
    assert.equal(result.receipt, null);
    assert.deepEqual(result.calls, []);
    assert.equal(result.originalUnchanged, true);
  });
}

for (const [name, plan, options, reason] of [
  ['wrong original cause', {}, { original: { reason: 'other_failure' } }, 'requires_original_data_readiness_failure'],
  ['previously mutated preflight', {}, { original: { mutationAttempted: true } }, 'requires_original_data_readiness_failure'],
  ['stale original evidence', {}, { original: { finishedAt: '2020-01-01T00:00:00Z' } }, 'origin_failure_is_not_fresh'],
  ['serial override', {}, { serial: 'emulator-5556' }, 'original_serial_mismatch'],
  ['unknown image revision', {}, { properties: 'Pkg.Revision=10\n' }, 'unsupported_system_image'],
  ['physical device', { qemu: '0' }, {}, 'refused_non_emulator'],
  ['different binary', { fingerprint: 'unqualified-fingerprint' }, {}, 'unsupported_emulator_identity'],
  ['wrong API', { api: '36' }, {}, 'unsupported_emulator_identity'],
  ['secondary Android user', { user: '10' }, {}, 'unsupported_android_user'],
  ['SIM not loaded', { sim: 'READY' }, {}, 'sim_not_loaded'],
  ['subscriptions not loaded', { isub: isub.replace('areAllSubscriptionsLoaded=true', 'areAllSubscriptionsLoaded=false') }, {}, 'subscriptions_not_loaded'],
  ['multiple modems', { isub: isub.replace('Active modem count=1', 'Active modem count=2') }, {}, 'requires_one_active_modem_and_subscription'],
  ['ambiguous mapping', { isub: isub.replace('ICCID:', '  Logical SIM slot 0: subId=2\nICCID:') }, {}, 'ambiguous_active_subscription_mapping'],
  ['missing Settings activity', { resolved: 'No activity found' }, {}, 'settings_activity_missing_or_ambiguous'],
  ['failed launch', { launchStatus: 'timeout' }, {}, 'settings_launch_unconfirmed'],
  ['unexpected focus', { focus: 'com.android.settings/.Settings' }, {}, 'unexpected_focused_window'],
  ['unsupported locale', { xml: ui({ title: 'Données mobiles' }) }, {}, 'mobile_data_title_missing_or_ambiguous'],
  ['disabled row', { xml: ui({ enabled: 'false' }) }, {}, 'mobile_data_control_not_actionable'],
  ['unknown widget', { xml: ui({ switchId: 'com.android.settings:id/unrelatedToggle' }) }, {}, 'mobile_data_clickable_row_missing'],
  ['unknown checked state', { xml: ui({ checked: 'unknown' }) }, {}, 'mobile_data_control_not_actionable'],
  ['out of screen geometry', { xml: ui({ top: 2390 }) }, {}, 'offscreen_ui_bounds'],
  ['subscription drift', { changeSubscription: true }, {}, 'subscription_changed'],
]) {
  test(name + ' refuses any data click and retains initial evidence', () => {
    const result = execute(plan, options);
    assertFailure(result, reason);
    assert.deepEqual(clicks(result), []);
  });
}

test('data that becomes ready naturally is not attributed to a Settings transition', () => {
  const result = execute({ alreadyReady: true });
  assert.equal(result.exit, 24);
  assert.equal(result.receipt.status, 'NOT_ATTEMPTED');
  assert.equal(result.receipt.reason, 'data_already_ready_without_settings');
  assert.equal(result.receipt.selectionAttempts, 0);
  assert.equal(launches(result).length, 0);
});

test('a tap return code does not prove a UI transition; no repeated click when state stays unchanged', () => {
  const result = execute({ initialChecked: false, frozenUiState: false });
  assertFailure(result, 'ui_transition_not_observed');
  assert.equal(clicks(result).length, 1);
});

test('a popup after OFF aborts the attempt before any second click', () => {
  const result = execute({ overlayAfterClick: true });
  assertFailure(result, 'unexpected_focused_window');
  assert.equal(clicks(result).length, 1);
});

test('checked=true and a general default of 1 never replace the actual default DATA guard', () => {
  const result = execute({ initialChecked: false, selectData: false }, { timeout: 2.5 });
  assertFailure(result);
  assert.equal(result.receipt.dataSelectionObserved, false);
  assert.equal(clicks(result).length, 1);
  assert.ok(result.seconds < 3.3, String(result.seconds));
});

test('bounded ADB timeout retains the receipt and cannot trigger a late UI click', () => {
  const result = execute({ delayAt: ['shell', 'wm', 'size'] }, { timeout: 1.2 });
  assertFailure(result);
  assert.equal(clicks(result).length, 0);
  assert.ok(result.receipt.commands.some(command => command.failure === 'command_timeout'));
  assert.ok(result.seconds < 2.0, String(result.seconds));
});

for (const [name, field, reason] of [['stderr', 'stderrAt', 'unexpected_command_stderr'],
  ['invalid UTF-8', 'invalidAt', 'invalid_command_encoding'], ['bounded output overflow', 'overflowAt', 'command_output_limit']]) {
  test(name + ' at the observation boundary fails before UI action', () => {
    const result = execute({ [field]: ['shell', 'dumpsys', 'isub'] });
    assertFailure(result, reason);
    assert.equal(launches(result).length, 0);
    assert.equal(clicks(result).length, 0);
  });
}

test('external original-evidence change is detected and never overwritten by the diagnostic', () => {
  const result = execute({ changeOriginalAt: ['shell', 'getprop', 'ro.kernel.qemu'] });
  assert.equal(result.exit, 24);
  assert.equal(result.receipt.reason, 'original_evidence_changed');
  assert.equal(result.receipt.initialFailurePreserved, false);
  assert.equal(result.originalUnchanged, false);
  assert.equal(launches(result).length, 0);
  assert.equal(clicks(result).length, 0);
});

test('malformed readiness is a complete FAIL receipt rather than an uncaught partial execution', () => {
  const result = execute({}, { original: { dataReadiness: [] } });
  assertFailure(result, 'invalid_origin_readiness_evidence');
  assert.deepEqual(result.calls, []);
});

test('ambiguous Settings resolver output never launches an activity', () => {
  const result = execute({ resolved: 'other.package/.Other\n' + component });
  assertFailure(result, 'settings_activity_missing_or_ambiguous');
  assert.equal(launches(result).length, 0);
});

test('multiple focused-window records are ambiguous even if one names the expected Settings component', () => {
  const result = execute({ focus: component + '}\n  mCurrentFocus=Window{def u0 other.package/.Other' });
  assertFailure(result, 'unexpected_focused_window');
  assert.equal(clicks(result).length, 0);
});

test('a row that moves during the last subscription read is dumped again before the first click', () => {
  const result = execute({ initialChecked: false, moveBeforeClick: true, movedXml: ui({ top: 900 }) });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(clicks(result)[0].args.slice(-2), ['385', '930']);
});

test('a second invocation cannot overwrite evidence or repeat a previously uncertain action', () => {
  execute({}, {}, (result, context) => {
    assert.equal(result.exit, 0);
    const previous = fs.readFileSync(context.receiptPath);
    const repeated = spawnSync('python3', context.args, { env: context.env, encoding: 'utf8', timeout: 3000 });
    assert.equal(repeated.status, 2);
    assert.ok(previous.equals(fs.readFileSync(context.receiptPath)));
  });
});

test('real parser rejects ambiguous rows, overlays and unsafe XML and accepts only observed geometry', () => {
  const duplicate = ui().replace('</hierarchy>', '') + ui().slice(ui().indexOf('<node'), ui().lastIndexOf('</hierarchy>')) + '</hierarchy>';
  const overlay = '<node package="com.android.settings" class="android.widget.Button" enabled="true" clickable="true" bounds="[300,420][500,445]"/>';
  const nested = '<hierarchy rotation="0">' + '<node>'.repeat(65) +
    ui({ checked: 'false' }).split('<hierarchy rotation="0">')[1].split('</hierarchy>')[0] +
    '</node>'.repeat(65) + '</hierarchy>';
  const cases = [
    { xml: ui({ checked: 'true' }), expected: true },
    { xml: duplicate.replaceAll('CHECKED_STATE', 'false'), reason: 'mobile_data_title_missing_or_ambiguous' },
    { xml: ui({ checked: 'false', extra: overlay }), reason: 'overlapping_click_target' },
    { xml: '<!DOCTYPE hierarchy [<!ENTITY payload "x">]>' + ui({ checked: 'false' }), reason: 'unsafe_ui_xml' },
    { xml: ui({ checked: 'false', titlePackage: 'unrelated.package' }), reason: 'mobile_data_title_missing_or_ambiguous' },
    { xml: nested, reason: 'ui_depth_limit' },
  ];
  const program = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('qualification',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
out=[]
for case in json.load(sys.stdin):
 try: out.append({'control':m.mobile_data_control(case['xml'],(1080,2400))})
 except m.QualificationError as e: out.append({'reason':e.reason})
print(json.dumps(out))`;
  const result = spawnSync('python3', ['-B', '-c', program, helper], { input: JSON.stringify(cases), encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed[0].control.checked, true);
  assert.deepEqual(parsed[0].control.tap, [385, 430]);
  for (let index = 1; index < cases.length; index++) assert.equal(parsed[index].reason, cases[index].reason);
});
