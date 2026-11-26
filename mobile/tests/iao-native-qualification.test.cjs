// Guards only: no simulated result in these tests is native qualification evidence.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative, flag, external = {}) {
  const file = path.resolve(__dirname, '..', relative); const imports = [];
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const requireLocal = name => {
    imports.push(name);
    if (Object.hasOwn(external, name)) return external[name];
    throw new Error(`Disabled qualification attempted import: ${name}`);
  };
  vm.runInThisContext(`(function(require,module,exports,process){${source}\n})`, { filename: file })(
    requireLocal, module, module.exports, { env: { EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: flag } });
  return { api: module.exports, imports };
}

for (const flag of [undefined, '', '0', 'true', '01']) test(`qualification harness refuses non-exact flag ${String(flag)} without any native/storage import`, async () => {
  const loaded = load('lib/iao-native-qualification.ts', flag);
  await assert.rejects(loaded.api.runIaoNativeQualification(), { code: 'qualification-disabled' });
  assert.deepEqual(loaded.imports, []);
});

test('the normal-build QA route mounts without importing the qualification module or opening fixtures', async () => {
  const React = require('react');
  const Renderer = require('react-test-renderer');
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const loaded = load('app/iao-qualification.tsx', undefined, {
    react: React, 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
  });
  let renderer;
  await Renderer.act(async () => { renderer = Renderer.create(React.createElement(loaded.api.default)); });
  assert.ok(JSON.stringify(renderer.toJSON()).includes('n’est pas disponible'));
  assert.deepEqual(loaded.imports.sort(), ['react', 'react-native', 'react/jsx-runtime'].sort());
  await Renderer.act(async () => renderer.unmount());
});

test('a failed cold restart identifies the active verification stage and restores global networking', async () => {
  const runId = '33333333-3333-4333-8333-333333333333';
  const resourceId = '44444444-4444-4444-8444-444444444444';
  const pendingId = '55555555-5555-4555-8555-555555555555';
  const firstAnswerHash = 'f'.repeat(64);
  const marker = `PURAMA_QA_PERSISTED_${runId}`;
  const checkpoint = { schema: 1, phase: 'prepared', runId, resourceId, pendingId, firstAnswerHash };
  let observer; let unsubscribed = false; let closed = 0; let released = 0; let digestDestroyed = 0;
  const packState = { status: 'verifying', phase: 'integrity', progress: 0.63,
    completedBytes: 402851413, totalBytes: 639458232 };
  const engine = {
    subscribe(callback) { observer = callback; return () => { unsubscribed = true; }; },
    getState: () => packState,
    async inspect() { observer?.(packState); throw Object.assign(new Error('synthetic storage wait'), { code: 'timeout' }); },
    async release() { released += 1; },
  };
  const originals = ['fetch', 'XMLHttpRequest', 'WebSocket'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const logs = []; const realLog = console.log;
  const loaded = load('lib/iao-native-qualification.ts', '1', {
    'expo-file-system': { Paths: { document: 'file:///fixtures' }, File: class {
      exists = true; size = 1024; textSync() { return JSON.stringify(checkpoint); }
    } },
    'expo-crypto': { CryptoDigestAlgorithm: { SHA256: 'sha256' }, digestStringAsync: async () => firstAnswerHash },
    'expo-device': { totalMemory: 4 * 1024 ** 3 },
    'react-native': { Platform: { OS: 'android' } },
    '../../shared/smarana': { isSmaranaUuid: value => /^[0-9a-f-]{36}$/.test(value) },
    './iao-local-engine': {
      getIaoLocalEngine: () => engine,
      IAO_LOCAL_ENGINE_BUDGETS: { verificationMs: 600_000, inferenceMs: 180_000, preparationMs: 1_800_000 },
      IAO_LOCAL_PACK_MANIFEST: { minimumMemoryBytes: 3 * 1024 ** 3,
        repository: 'synthetic/model', revision: 'a'.repeat(40), model: { bytes: 639446688, sha256: 'b'.repeat(64) } },
    },
    './iao-local-digest': { createIaoLocalDigest: async () => ({
      implementation: 'native-sha256',
      update(bytes) { assert.deepEqual([...bytes], [97, 98, 99]); assert.equal(bytes.byteOffset, 1); },
      digestHex: () => 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      destroy() { digestDestroyed++; },
    }) },
    './smarana-native': {
      closeSmaranaStore: async () => { closed += 1; },
      openSmaranaStore: async () => ({ read: async () => ({ resourceId, syncState: 'pending', payload: {
        draft: `${marker}\nBrouillon exact : éàç, مرحبا, 👋`, messages: [
          { id: pendingId, role: 'assistant', state: 'interrupted', content: `${marker}:réponse-partielle` },
          { id: 'first', role: 'assistant', state: 'complete', content: 'Bonjour' },
        ],
      } }) }),
    },
  });
  console.log = line => { logs.push(line); };
  let receipt;
  try { receipt = await loaded.api.runIaoNativeQualification(); }
  finally { console.log = realLog; }
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.code, 'timeout');
  assert.equal(receipt.attemptedPhase, 'complete'); assert.equal(receipt.stage, 'pack-inspection');
  assert.deepEqual(receipt.pack, { status: 'verifying', phase: 'integrity', progressPercent: 63 });
  assert.ok(Number.isFinite(receipt.elapsedMs)); assert.ok(Number.isFinite(receipt.stageElapsedMs));
  assert.ok(logs.some(line => line.startsWith('PURAMA_OFFLINE_QUALIFICATION_PROGRESS:') && line.includes('integrity')));
  assert.equal(unsubscribed, true); assert.equal(closed, 1); assert.equal(released, 1);
  assert.equal(digestDestroyed, 1);
  for (const [name, descriptor] of originals) assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, name), descriptor);
  assert.ok(logs.every(line => !line.includes(marker) && !line.includes(firstAnswerHash)), 'progress receipts contain no message or digest fixture payload');
});

for (const scenario of [
  { implementation: 'noble-sha256', code: 'native-sha256-required' },
  { implementation: 'native-sha256', code: 'native-sha256-self-test-failed' },
  { implementation: 'noble-sha256', code: 'native-sha256-required', cleanupFails: true },
  { implementation: 'native-sha256', code: 'native-sha256-self-test-failed', cleanupFails: true },
  { implementation: 'native-sha256', code: 'native-qualification-failed', cleanupFails: true, vectorPasses: true },
]) test(`device qualification refuses ${scenario.code}${scenario.cleanupFails ? ' with cleanup failure' : ''} before model work`, async () => {
  let destroyed = 0; let released = 0; let closed = 0;
  const engine = {
    subscribe: () => () => {}, getState: () => ({ status: 'absent', progress: 0 }),
    release: async () => { released++; },
    prepare: async () => assert.fail('unqualified integrity backend must not reach model preparation'),
  };
  const loaded = load('lib/iao-native-qualification.ts', '1', {
    'expo-file-system': { Paths: { document: 'file:///fixtures' }, File: class { exists = false; } },
    'expo-crypto': { randomUUID: () => '33333333-3333-4333-8333-333333333333' },
    'expo-device': { totalMemory: 4 * 1024 ** 3 }, 'react-native': { Platform: { OS: 'android' } },
    '../../shared/smarana': { isSmaranaUuid: () => true },
    './iao-local-engine': { getIaoLocalEngine: () => engine,
      IAO_LOCAL_ENGINE_BUDGETS: { verificationMs: 600_000, inferenceMs: 180_000 },
      IAO_LOCAL_PACK_MANIFEST: {} },
    './smarana-native': { closeSmaranaStore: async () => { closed++; },
      openSmaranaStore: async () => assert.fail('unqualified integrity backend must not open the store') },
    './iao-local-digest': { createIaoLocalDigest: async () => ({ implementation: scenario.implementation,
      update() {},
      digestHex: () => scenario.vectorPasses ? 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' : '0'.repeat(64),
      destroy() { destroyed++; if (scenario.cleanupFails) throw new Error('synthetic cleanup failure'); } }) },
  });
  const log = console.log; console.log = () => {};
  let receipt;
  try { receipt = await loaded.api.runIaoNativeQualification(); } finally { console.log = log; }
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.stage, 'integrity-backend');
  assert.equal(receipt.code, scenario.code); assert.equal(destroyed, 1);
  assert.equal(released, 1); assert.equal(closed, 1);
});
