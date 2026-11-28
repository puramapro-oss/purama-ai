// Real entrypoints + real JS registry getters. Native initialization is an explicit fake boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function load(expo, { entry = 'index.ts', onExpoImport, core = { SharedObject: class {} } } = {}) {
  const cache = new Map();
  const context = vm.createContext({ expo });
  function local(relative) {
    const file = path.join(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const requireLocal = name => {
      if (name === 'expo-modules-core') { onExpoImport?.(); return core; }
      if (name === './contract') return local('contract.ts');
      throw new Error('Unexpected module dependency: ' + name);
    };
    vm.runInContext(`(function(require,module,exports){${source}\n})`, context, { filename: file })(requireLocal, module, module.exports);
    return module.exports;
  }
  return local(entry);
}

test('public initialization is retained but digest lookup stays deferred and uses one identity', () => {
  const names = []; let imports = 0;
  const native = { Sha256Digest: class {} };
  const modules = new Proxy({}, { get(_target, name) { names.push(name); return native; } });
  const api = load({ modules }, { onExpoImport: () => { imports += 1; } });
  assert.equal(imports, 1);
  assert.deepEqual(names, []);
  assert.equal(api.MAX_DIGEST_BLOCK_BYTES, 262144);
  assert.equal(api.getPuramaLocalDigestModule(), native);
  assert.deepEqual(names, ['PuramaLocalDigest']);
});

test('only an absent entry in a valid registry returns null', () => {
  assert.equal(load({ modules: {} }).getPuramaLocalDigestModule(), null);
  assert.equal(load({ modules: { PuramaLocalDigest: null } }).getPuramaLocalDigestModule(), null);
});

test('a missing SharedObject runtime is refused before accessing the native registry', () => {
  const expo = Object.defineProperty({}, 'modules', { get() { throw new Error('unexpected registry access'); } });
  for (const core of [{}, { SharedObject: null }, { SharedObject: 0 }, { SharedObject: {} }]) {
    assert.throws(() => load(expo, { core }).getPuramaLocalDigestModule(), /SharedObject runtime is unavailable/);
  }
});

test('an unavailable or malformed native registry is an error', () => {
  for (const expo of [undefined, null, {}, { modules: null }, { modules: 42 }]) {
    assert.throws(() => load(expo).getPuramaLocalDigestModule(), /registry is unavailable/);
  }
});

test('registry and constructor getter failures propagate without an absence fallback', () => {
  const failure = new Error('synthetic native getter failure');
  const throwing = () => { throw failure; };
  const cases = [
    Object.defineProperty({}, 'modules', { get: throwing }),
    { modules: new Proxy({}, { get: throwing }) },
    { modules: { PuramaLocalDigest: Object.defineProperty({}, 'Sha256Digest', { get: throwing }) } },
  ];
  for (const expo of cases) {
    assert.throws(() => load(expo).getPuramaLocalDigestModule(), error => error === failure);
  }
});

test('a present native module without a constructor cannot masquerade as absence', () => {
  for (const native of [0, false, '', {}, { Sha256Digest: null }, { Sha256Digest: 42 }]) {
    assert.throws(() => load({ modules: { PuramaLocalDigest: native } }).getPuramaLocalDigestModule(), /constructor/);
  }
});

test('a failed native lookup does not poison a later lookup', () => {
  let first = true;
  const native = { Sha256Digest: class {} };
  const modules = new Proxy({}, { get() { if (first) { first = false; throw new Error('temporary failure'); } return native; } });
  const api = load({ modules });
  assert.throws(() => api.getPuramaLocalDigestModule(), /temporary failure/);
  assert.equal(api.getPuramaLocalDigestModule(), native);
});

test('public Expo initialization errors are not converted into native absence', () => {
  const failure = new Error('synthetic Expo initialization failure');
  assert.throws(() => load(undefined, { onExpoImport: () => { throw failure; } }), error => error === failure);
});

test('web declares native absence without importing Expo or inspecting a native registry', () => {
  const forbidden = () => { throw new Error('unexpected native access'); };
  const api = load(new Proxy({}, { get: forbidden }), { entry: 'index.web.ts', onExpoImport: forbidden });
  assert.equal(api.getPuramaLocalDigestModule(), null);
  assert.equal(api.MAX_DIGEST_BLOCK_BYTES, 262144);
});
