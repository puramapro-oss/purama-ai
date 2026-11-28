// Guard and harness tests. Every native/file boundary below is an explicit fake;
// only the iOS simulator receipt can qualify the actual Expo/Hermes execution.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const contract = require('../lib/iao-digest-qualification-contract.json');
const runId = '33333333-3333-4333-8333-333333333333';
const commit = 'a'.repeat(40);
const validEnv = {
  EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: '1',
  EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID: runId,
  EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT: commit,
};

function loadHarness(options = {}) {
  const imports = [], calls = [], objects = [], writes = [], published = [];
  class NativeDigest {
    constructor() { this.hash = crypto.createHash('sha256'); this.retainedInputs = []; this.closed = false; this.released = false; objects.push(this); }
    update(input) {
      calls.push(['update', this, input]);
      assert.equal(this.released, false, 'fixture must not call a native method after release');
      if (options.throwUndefined && input instanceof Uint8Array && input.byteLength === 3) throw undefined;
      if (this.closed) {
        if (options.acceptFinalizedUpdate) return;
        throw new Error('closed fake digest');
      }
      if (!(input instanceof Uint8Array)) {
        if (options.acceptUnsupported) return;
        throw new Error('unsupported fake type');
      }
      if (input.byteLength > 262144) {
        if (options.acceptOversized) return;
        throw new Error('oversized fake block');
      }
      if (options.retainInput) this.retainedInputs.push(input);
      else this.hash.update(input);
    }
    digestHex() {
      calls.push(['digestHex', this]);
      assert.equal(this.released, false, 'fixture must not call a native method after release');
      if (this.closed) throw new Error('closed fake digest');
      this.closed = true;
      if (options.retainInput) for (const input of this.retainedInputs) this.hash.update(input);
      const value = this.hash.digest('hex');
      return options.corruptEmpty && value.startsWith('e3b0c4') ? '0'.repeat(64) : value;
    }
    destroy() {
      calls.push(['destroy', this]);
      assert.equal(this.released, false, 'fixture must not call a native method after release');
      this.closed = true;
      if (options.destroyThrows) throw new Error('private cleanup details must never enter receipt');
    }
    release() {
      calls.push(['release', this]);
      assert.equal(this.released, false, 'fixture must release each raw SharedObject once');
      this.released = true;
      if (options.releaseThrows) throw new Error('private release details must never enter receipt');
    }
  }
  const files = new Map(options.existingReceipt ? [[contract.receiptFile, '{"previous":true}']] : []);
  const externals = {
    'expo-file-system': {
      Paths: { document: 'file:///synthetic-documents' },
      File: class {
        constructor(directory, filename) { this.filename = filename; calls.push(['file', directory, filename]); }
        get exists() { return files.has(this.filename); }
        create(value) {
          calls.push(['create', value]);
          assert.equal(value.overwrite, false);
          assert.equal(files.has(this.filename), false);
          files.set(this.filename, '');
        }
        write(value) {
          if (options.writeThrows) throw new Error('synthetic write failure');
          files.set(this.filename, value); writes.push(JSON.parse(value));
        }
        textSync() { return options.readbackMismatch ? '{}' : files.get(this.filename); }
        move(destination) {
          calls.push(['move', this.filename, destination.filename]);
          assert.equal(files.has(destination.filename), false);
          assert.equal(destination.filename, contract.receiptFile);
          assert.ok(this.filename.endsWith(`.${runId}.pending`));
          const value = files.get(this.filename);
          files.delete(this.filename); files.set(destination.filename, value);
          this.filename = destination.filename;
          published.push(JSON.parse(value));
        }
      },
    },
    'react-native': {
      Platform: { OS: options.platform ?? 'ios' },
      TurboModuleRegistry: { get(name) {
        assert.equal(name, 'SourceCode');
        return options.legacySourceCode ? null : { getConstants: () => ({ scriptURL: options.scriptURL ?? 'file:///synthetic/PuramaAI.app/main.jsbundle' }) };
      } },
      NativeModules: { SourceCode: { scriptURL: options.scriptURL ?? 'file:///synthetic/PuramaAI.app/main.jsbundle' } },
    },
    '../modules/purama-local-digest/index': {
      MAX_DIGEST_BLOCK_BYTES: 262144,
      getPuramaLocalDigestModule: () => options.absentNative ? null : { Sha256Digest: NativeDigest },
    },
    './iao-local-digest': {
      async createIaoLocalDigest() {
        const digest = new NativeDigest(); let released = false;
        return {
          implementation: options.nobleAdapter ? 'noble-sha256' : 'native-sha256',
          update: input => digest.update(input),
          digestHex: () => options.badAdapterVector ? '0'.repeat(64) : digest.digestHex(),
          destroy() {
            calls.push(['adapterDestroy']);
            if (released) return;
            released = true;
            try { digest.destroy(); } finally { digest.release(); }
            if (options.adapterCleanupThrows) throw new Error('private adapter cleanup details');
          },
        };
      },
    },
  };
  const file = path.join(root, 'lib/iao-digest-qualification.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const requireLocal = name => {
    imports.push(name);
    if (name === './iao-digest-qualification-contract.json') return contract;
    if (Object.hasOwn(externals, name)) return externals[name];
    throw new Error(`Unexpected fixture import: ${name}`);
  };
  const env = { ...validEnv, ...options.env };
  const runtime = { HermesInternal: options.noHermes ? undefined : {} };
  vm.runInThisContext(`(function(require,module,exports,process,globalThis){${code}\n})`, { filename: file })(
    requireLocal, module, module.exports, { env }, runtime);
  return { api: module.exports, imports, calls, objects, writes, published, files };
}

for (const flag of [undefined, '', '0', 'true', '01']) {
  test(`digest qualification refuses non-exact flag ${String(flag)} before native/file imports`, async () => {
    const loaded = loadHarness({ env: { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION: flag } });
    await assert.rejects(loaded.api.runIaoDigestQualification(), { code: 'qualification-disabled' });
    assert.deepEqual(loaded.imports, ['./iao-digest-qualification-contract.json']);
    assert.deepEqual(loaded.calls, []);
  });
}

test('digest and offline qualifications cannot be enabled together', async () => {
  const loaded = loadHarness({ env: { EXPO_PUBLIC_PURAMA_OFFLINE_QUALIFICATION: '1' } });
  await assert.rejects(loaded.api.runIaoDigestQualification(), { code: 'qualification-conflict' });
  assert.deepEqual(loaded.imports, ['./iao-digest-qualification-contract.json']);
});

for (const env of [
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID: undefined },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID: '00000000-0000-0000-0000-000000000000' },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID: '../receipt' },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_RUN_ID: '33333333-3333-4333-7333-333333333333' },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT: undefined },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT: 'a'.repeat(39) },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT: 'g'.repeat(40) },
  { EXPO_PUBLIC_PURAMA_DIGEST_QUALIFICATION_COMMIT: 'A'.repeat(40) },
]) test(`invalid build identity refuses imports: ${JSON.stringify(env)}`, async () => {
  const loaded = loadHarness({ env });
  await assert.rejects(loaded.api.runIaoDigestQualification(), { code: 'qualification-identity-invalid' });
  assert.deepEqual(loaded.imports, ['./iao-digest-qualification-contract.json']);
});

test('the synthetic harness reaches every assertion and emits exactly the agreed receipt schema', async () => {
  const loaded = loadHarness();
  const receipt = await loaded.api.runIaoDigestQualification();
  assert.equal(receipt.status, 'PASS');
  assert.deepEqual(Object.keys(receipt).sort(), ['schema', 'status', 'runId', 'commit', 'platform', 'engine', 'bundleSource', 'backend', 'checks', 'elapsedMs', 'completedAt', 'errorCode'].sort());
  assert.equal(receipt.schema, 1); assert.equal(receipt.runId, runId); assert.equal(receipt.commit, commit);
  assert.equal(receipt.platform, 'ios'); assert.equal(receipt.engine, 'hermes');
  assert.equal(receipt.bundleSource, 'embedded'); assert.equal(receipt.backend, 'native-sha256');
  assert.equal(receipt.errorCode, null); assert.ok(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0);
  assert.equal(new Date(receipt.completedAt).toISOString(), receipt.completedAt);
  assert.deepEqual(Object.keys(receipt.checks).sort(), [...contract.checks].sort());
  assert.ok(Object.values(receipt.checks).every(value => value === true));
  assert.ok(loaded.objects.every(object => object.released));
  assert.equal(loaded.calls.filter(call => call[0] === 'release').length, loaded.objects.length);
  assert.equal(loaded.calls.filter(call => call[0] === 'adapterDestroy').length, 2);
  assert.deepEqual(loaded.calls.find(call => call[0] === 'file'), ['file', 'file:///synthetic-documents', contract.receiptFile]);
  assert.deepEqual(loaded.writes, [receipt]);
  assert.deepEqual(loaded.published, [receipt]);
  assert.equal(loaded.files.size, 1);
  assert.ok(!JSON.stringify(receipt).includes('file:///'), 'no local device path enters the receipt');
});

test('repeated route mounts share one execution and one written receipt', async () => {
  const loaded = loadHarness();
  const first = loaded.api.runIaoDigestQualification(), second = loaded.api.runIaoDigestQualification();
  assert.equal(first, second); await first;
  assert.equal(loaded.writes.length, 1);
});

test('the existing SourceCode facade is accepted when no TurboModule is returned', async () => {
  assert.equal((await loadHarness({ legacySourceCode: true }).api.runIaoDigestQualification()).status, 'PASS');
});

for (const [options, code] of [
  [{ platform: 'android' }, 'ios-required'],
  [{ platform: 'web' }, 'ios-required'],
  [{ noHermes: true }, 'hermes-required'],
  [{ scriptURL: 'http://localhost:8081/index.bundle' }, 'embedded-bundle-required'],
  [{ scriptURL: 'https://example.invalid/main.jsbundle' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///Documents/main.jsbundle' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///PuramaAI.app/main.jsbundle?remote=1' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///PuramaAI.app/main.jsbundle#fragment' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///invalid\0/PuramaAI.app/main.jsbundle' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///invalid\r/PuramaAI.app/main.jsbundle' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///invalid\n/PuramaAI.app/main.jsbundle' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///PuramaAI.app/main.jsbundle\r' }, 'embedded-bundle-required'],
  [{ scriptURL: 'file:///PuramaAI.app/main.jsbundle\n' }, 'embedded-bundle-required'],
  [{ absentNative: true }, 'native-digest-required'],
]) test(`missing real-runtime prerequisite becomes a diagnostic FAIL: ${code} ${JSON.stringify(options)}`, async () => {
  const loaded = loadHarness(options), receipt = await loaded.api.runIaoDigestQualification();
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.errorCode, code);
  assert.ok(Object.values(receipt.checks).every(value => value === false));
  assert.equal(loaded.objects.length, 0); assert.deepEqual(loaded.writes, [receipt]);
});

for (const [options, code] of [
  [{ corruptEmpty: true }, 'empty-vector-failed'],
  [{ acceptFinalizedUpdate: true }, 'finalized-update-accepted'],
  [{ retainInput: true }, 'synchronous-consumption-failed'],
  [{ acceptUnsupported: true }, 'unsupported-type-accepted'],
  [{ acceptOversized: true }, 'oversized-block-accepted'],
  [{ nobleAdapter: true }, 'native-adapter-required'],
  [{ badAdapterVector: true }, 'adapter-offset-vector-failed'],
]) test(`the harness catches a faulty native/adapter boundary: ${code}`, async () => {
  const loaded = loadHarness(options), receipt = await loaded.api.runIaoDigestQualification();
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.errorCode, code);
  assert.ok(loaded.objects.every(object => object.released));
  assert.equal(loaded.writes.length, 1);
});

for (const option of ['destroyThrows', 'releaseThrows', 'adapterCleanupThrows']) {
  test(`a cleanup failure prevents PASS and does not leak native exception details: ${option}`, async () => {
    const loaded = loadHarness({ [option]: true }), receipt = await loaded.api.runIaoDigestQualification();
    assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.errorCode, 'native-digest-qualification-failed');
    assert.ok(loaded.objects.every(object => object.released));
    assert.ok(!JSON.stringify(receipt).includes('private'));
    if (option === 'releaseThrows') assert.equal(receipt.checks.nativeReleaseCompleted, false);
  });
}

test('the first vector failure survives subsequent cleanup failures', async () => {
  const receipt = await loadHarness({ corruptEmpty: true, destroyThrows: true, releaseThrows: true }).api.runIaoDigestQualification();
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.errorCode, 'empty-vector-failed');
});

test('a thrown undefined remains a failure and all allocated resources are released', async () => {
  const loaded = loadHarness({ throwUndefined: true, destroyThrows: true });
  const receipt = await loaded.api.runIaoDigestQualification();
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.errorCode, 'native-digest-qualification-failed');
  assert.ok(loaded.objects.every(object => object.released));
  assert.equal(receipt.checks.offsetViewVector, false);
});

test('a failed receipt write rejects without claiming completion', async () => {
  const loaded = loadHarness({ writeThrows: true });
  await assert.rejects(loaded.api.runIaoDigestQualification(), /synthetic write failure/);
  assert.deepEqual(loaded.writes, []); assert.deepEqual(loaded.published, []);
  assert.equal(loaded.files.has(contract.receiptFile), false);
  assert.ok(loaded.objects.every(object => object.released));
});

test('an inconsistent receipt readback is refused', async () => {
  const loaded = loadHarness({ readbackMismatch: true });
  await assert.rejects(loaded.api.runIaoDigestQualification(), { code: 'receipt-write-mismatch' });
  assert.deepEqual(loaded.published, []); assert.equal(loaded.files.has(contract.receiptFile), false);
});

test('an existing final receipt is preserved and never overwritten', async () => {
  const loaded = loadHarness({ existingReceipt: true });
  await assert.rejects(loaded.api.runIaoDigestQualification(), { code: 'receipt-already-exists' });
  assert.deepEqual(loaded.published, []); assert.deepEqual(loaded.writes, []);
  assert.equal(loaded.files.get(contract.receiptFile), '{"previous":true}');
});

test('a completion callback failure is recorded before any PASS receipt is written', async () => {
  const loaded = loadHarness(); let statuses = 0;
  const receipt = await loaded.api.runIaoDigestQualification(() => { if (++statuses === 2) throw new Error('private UI error'); });
  assert.equal(receipt.status, 'FAIL'); assert.equal(receipt.errorCode, 'native-digest-qualification-failed');
  assert.equal(loaded.writes[0].status, 'FAIL');
});
