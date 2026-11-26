// Real adapter + Noble + independent node:crypto oracle. Expo is a declared fake
// boundary here; module/tests exercises native cores and the device fixture the bridge.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ts = require('typescript');

function loadDigest(nativeLookup, nobleOverride) {
  const project = path.resolve(__dirname, '..');
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = name => {
      if (name === '../modules/purama-local-digest/index') return {
        getPuramaLocalDigestModule: () => nativeLookup('PuramaLocalDigest'),
      };
      if (name === '@noble/hashes/sha256' && nobleOverride) return nobleOverride;
      if (name.startsWith('@noble/hashes/')) return require(name);
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      throw new Error(`Unreviewed digest dependency: ${name}`);
    };
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  return load(path.join(project, 'lib/iao-local-digest.ts'));
}

function nativeBoundary(hooks = {}) {
  const calls = { constructed: 0, updates: [], destroyed: 0, released: 0 };
  class Sha256Digest {
    constructor() { calls.constructed++; hooks.construct?.(); this.hash = createHash('sha256'); }
    update(bytes) { calls.updates.push({ bytes: bytes.byteLength, offset: bytes.byteOffset }); hooks.update?.(); this.hash.update(bytes); }
    digestHex() { hooks.digest?.(); return this.hash.digest('hex'); }
    destroy() { calls.destroyed++; hooks.destroy?.(); }
    release() { calls.released++; hooks.release?.(); }
  }
  return { module: { Sha256Digest }, calls };
}

const noNoble = { sha256: { create() { assert.fail('Native errors must not cause a Noble fallback.'); } } };

test('import is passive; only explicit native absence selects the real Noble fallback', async () => {
  let lookups = 0;
  const api = loadDigest(name => { assert.equal(name, 'PuramaLocalDigest'); lookups++; return null; });
  assert.equal(lookups, 0);
  const digest = await api.createIaoLocalDigest();
  assert.equal(lookups, 1); assert.equal(digest.implementation, 'noble-sha256');
  digest.update(new Uint8Array([97, 98, 99]));
  assert.equal(digest.digestHex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  digest.destroy(); digest.destroy();
});

for (const native of [false, true]) {
  test(`${native ? 'native adapter' : 'Noble fallback'} hashes bounded offset views without including sentinels`, async () => {
    const boundary = nativeBoundary();
    const api = loadDigest(() => native ? boundary.module : null, native ? noNoble : undefined);
    const digest = await api.createIaoLocalDigest();
    assert.equal(digest.implementation, native ? 'native-sha256' : 'noble-sha256');
    const input = Uint8Array.from({ length: 3 * 256 * 1024 + 37 }, (_, i) => i % 251);
    const expected = createHash('sha256').update(input.subarray(13, input.length - 7)).digest('hex');
    digest.update(new Uint8Array());
    for (let offset = 13; offset < input.length - 7; offset += 256 * 1024) {
      digest.update(input.subarray(offset, Math.min(offset + 256 * 1024, input.length - 7)));
    }
    assert.equal(digest.digestHex(), expected);
    digest.destroy(); digest.destroy();
    if (native) {
      assert.equal(boundary.calls.updates[1].offset, 13);
      assert.equal(boundary.calls.destroyed, 1); assert.equal(boundary.calls.released, 1);
    }
  });

  test(`${native ? 'native adapter' : 'Noble fallback'} rejects oversized and non-byte input before consuming it`, async () => {
    const boundary = nativeBoundary();
    const digest = await loadDigest(() => native ? boundary.module : null).createIaoLocalDigest();
    assert.throws(() => digest.update(new Uint8Array(256 * 1024 + 1)), RangeError);
    assert.throws(() => digest.update(new Uint16Array([1, 2])), RangeError);
    assert.throws(() => digest.update([1, 2]), RangeError);
    assert.equal(boundary.calls.updates.length, 0);
    digest.update(new Uint8Array([97, 98, 99]));
    assert.equal(digest.digestHex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    digest.destroy();
  });
}

test('native lookup and constructor failures propagate without silently changing implementations', async () => {
  const error = new Error('synthetic native initialization failure');
  await assert.rejects(loadDigest(() => { throw error; }, noNoble).createIaoLocalDigest(), e => e === error);
  const boundary = nativeBoundary({ construct() { throw error; } });
  await assert.rejects(loadDigest(() => boundary.module, noNoble).createIaoLocalDigest(), e => e === error);
  await assert.rejects(loadDigest(() => undefined, noNoble).createIaoLocalDigest(), TypeError);
});

for (const phase of ['update', 'digest']) {
  test(`native ${phase} failure propagates; cleanup still releases the context exactly once`, async () => {
    const error = new Error(`synthetic native ${phase} failure`);
    const boundary = nativeBoundary({ [phase]() { throw error; } });
    const digest = await loadDigest(() => boundary.module, noNoble).createIaoLocalDigest();
    assert.throws(() => phase === 'update' ? digest.update(new Uint8Array([1])) : digest.digestHex(), e => e === error);
    digest.destroy(); digest.destroy();
    assert.equal(boundary.calls.destroyed, 1); assert.equal(boundary.calls.released, 1);
  });
}

test('release is attempted even if native destruction fails, preserving the first failure', async () => {
  const primary = new Error('synthetic destroy failure');
  const secondary = new Error('synthetic release failure');
  const boundary = nativeBoundary({ destroy() { throw primary; }, release() { throw secondary; } });
  const digest = await loadDigest(() => boundary.module, noNoble).createIaoLocalDigest();
  assert.throws(() => digest.destroy(), e => e === primary);
  digest.destroy();
  assert.equal(boundary.calls.destroyed, 1); assert.equal(boundary.calls.released, 1);
});

test('a standalone native release failure is surfaced and never blindly retried', async () => {
  const error = new Error('synthetic release failure');
  const boundary = nativeBoundary({ release() { throw error; } });
  const digest = await loadDigest(() => boundary.module, noNoble).createIaoLocalDigest();
  assert.throws(() => digest.destroy(), e => e === error);
  digest.destroy();
  assert.equal(boundary.calls.released, 1);
});
